const axios = require('axios');

const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs';

// Skill normalization map — convert framework names to API-friendly terms
const SKILL_NORMALIZE = {
  'node.js': 'nodejs',
  'express.js': 'express',
  'react.js': 'react',
  'vue.js': 'vue',
  'angular.js': 'angular',
  'next.js': 'nextjs',
  'passport.js': 'passport',
  'socket.io': 'socketio',
  'three.js': 'threejs',
  'd3.js': 'd3',
  'c++': 'cpp',
  'c#': 'csharp',
  '.net': 'dotnet',
  'ui/ux': 'ui ux',
  'ci/cd': 'ci cd',
};

// Skills that are too generic to search alone
const TOO_GENERIC = new Set([
  'css', 'html', 'git', 'ejs', 'joi', 'api', 'sql',
  'error handling', 'data structures', 'algorithms',
  'object-oriented programming', 'authentication',
  'database management', 'testing', 'debugging',
  'problem solving', 'communication', 'teamwork',
]);

/**
 * Normalize a skill for Adzuna search (remove dots, map aliases)
 */
function normalizeForSearch(skill) {
  const lower = skill.toLowerCase().trim();
  return SKILL_NORMALIZE[lower] || lower.replace(/\.js$/i, '').replace(/[^a-zA-Z0-9+#\s-]/g, '').trim();
}

/**
 * Normalize a skill for matching against job descriptions
 */
function normalizeSkill(skill) {
  const lower = skill.toLowerCase().trim();
  return SKILL_NORMALIZE[lower] || lower;
}

/**
 * Fetch jobs from Adzuna API using MULTIPLE small queries (1-2 keywords each)
 * then merge and deduplicate results.
 * 
 * Adzuna uses AND logic for spaces, so "java mongodb nodejs" = 0 results.
 * Instead, we fire multiple targeted queries and combine.
 */
async function fetchJobs(skills, country = 'us') {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;

  if (!appId || !appKey) {
    throw new Error('Adzuna API credentials not configured. Please set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env');
  }

  // Clean and normalize skills for search
  const cleanSkills = skills
    .map(normalizeForSearch)
    .filter(s => s.length > 1 && !TOO_GENERIC.has(s.toLowerCase()));

  if (cleanSkills.length === 0) {
    console.warn('⚠️ No searchable skills after filtering');
    return [];
  }

  // Strategy: make 2-3 small queries with 1-2 keywords each, then merge
  const queries = buildSmartQueries(cleanSkills, skills);
  console.log(`🔎 Adzuna queries: ${JSON.stringify(queries)}`);

  const seenIds = new Set();
  const allJobs = [];

  for (const query of queries) {
    try {
      const jobs = await executeAdzunaQuery(appId, appKey, query, country, 25);
      for (const job of jobs) {
        // Deduplicate by title + company
        const key = `${job.title}|${job.company}`.toLowerCase();
        if (!seenIds.has(key)) {
          seenIds.add(key);
          allJobs.push(job);
        }
      }
      console.log(`   "${query}" → ${jobs.length} jobs (total unique: ${allJobs.length})`);
    } catch (err) {
      console.warn(`   "${query}" → failed: ${err.message}`);
    }
  }

  console.log(`📋 Total unique jobs fetched: ${allJobs.length}`);
  return allJobs;
}

/**
 * Build smart search queries from skills.
 * Each query has at most 2 keywords to avoid AND-restriction killing results.
 */
function buildSmartQueries(normalizedSkills, originalSkills) {
  const queries = [];
  const used = new Set();

  // Priority 1: Use the top skill paired with "developer"/"engineer"
  if (normalizedSkills.length > 0) {
    const topSkill = normalizedSkills[0];
    queries.push(`${topSkill} developer`);
    used.add(topSkill);
  }

  // Priority 2: Pair second skill with "developer" or use alone
  if (normalizedSkills.length > 1) {
    const secondSkill = normalizedSkills[1];
    if (!used.has(secondSkill)) {
      queries.push(`${secondSkill} developer`);
      used.add(secondSkill);
    }
  }

  // Priority 3: Try a role-based query if roles are available
  // Look for role-like terms in original skills
  const roleTerms = originalSkills
    .filter(s => s.toLowerCase().includes('developer') ||
                 s.toLowerCase().includes('engineer') ||
                 s.toLowerCase().includes('full-stack') ||
                 s.toLowerCase().includes('full stack') ||
                 s.toLowerCase().includes('frontend') ||
                 s.toLowerCase().includes('backend') ||
                 s.toLowerCase().includes('data scien') ||
                 s.toLowerCase().includes('designer'))
    .map(s => s.replace(/[^a-zA-Z\s-]/g, '').trim());

  if (roleTerms.length > 0) {
    const roleQuery = roleTerms[0];
    if (!queries.some(q => q.toLowerCase() === roleQuery.toLowerCase())) {
      queries.push(roleQuery);
    }
  }

  // Priority 4: Add a third skill as standalone if we have room
  if (normalizedSkills.length > 2 && queries.length < 4) {
    const thirdSkill = normalizedSkills[2];
    if (!used.has(thirdSkill)) {
      queries.push(thirdSkill);
    }
  }

  // Ensure at least one query exists
  if (queries.length === 0) {
    queries.push('developer');
  }

  return queries.slice(0, 4); // Max 4 queries
}

/**
 * Execute a single Adzuna API query
 */
async function executeAdzunaQuery(appId, appKey, query, country, resultsPerPage) {
  const response = await axios.get(`${ADZUNA_BASE_URL}/${country}/search/1`, {
    params: {
      app_id: appId,
      app_key: appKey,
      results_per_page: resultsPerPage,
      what: query
    },
    timeout: 15000
  });

  if (!response.data || !response.data.results) {
    return [];
  }

  return response.data.results.map(job => ({
    title: job.title || 'Untitled Position',
    description: job.description || '',
    apply_url: job.redirect_url || '',
    salary: formatSalary(job.salary_min, job.salary_max),
    company: job.company?.display_name || 'Company Not Listed',
    location: job.location?.display_name || 'Location Not Specified',
    created: job.created || ''
  }));
}

/**
 * Format salary range into a readable string
 */
function formatSalary(min, max) {
  if (!min && !max) return 'Not specified';
  if (min && max) {
    return `$${Math.round(min).toLocaleString()} - $${Math.round(max).toLocaleString()}`;
  }
  if (min) return `From $${Math.round(min).toLocaleString()}`;
  return `Up to $${Math.round(max).toLocaleString()}`;
}

/**
 * Filter jobs — keep only those with at least 1 matching skill in title or description
 */
function filterJobs(jobs, skills) {
  const normalizedSkills = skills.map(s => normalizeForSearch(s).toLowerCase());

  return jobs.filter(job => {
    const jobText = `${job.title} ${job.description}`.toLowerCase();

    return normalizedSkills.some(skill => {
      // For short skills, match as whole word to avoid false positives
      if (skill.length <= 3) {
        const regex = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return regex.test(jobText);
      }
      return jobText.includes(skill);
    });
  });
}

module.exports = { fetchJobs, filterJobs, normalizeSkill };

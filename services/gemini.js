const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_NAME = 'gemini-2.5-flash';

// In-memory cache (avoids re-calling API for same resume)
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Global rate limiter
let lastRequestTime = 0;
const MIN_REQUEST_GAP = 5500; // spacing between Gemini calls to reduce 429s on free tier

function getCacheKey(text) {
  const snippet = text.substring(0, 200).replace(/\s+/g, ' ').trim();
  return `${snippet.length}_${text.length}_${snippet.slice(0, 50)}`;
}

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_GAP) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_GAP - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Retry wrapper for Gemini. Pass { maxRetries: 1 } to fail fast (no long waits).
 * Default keeps 65s wait on 429 for skill extraction and PDF flows.
 */
async function callWithRetry(fn, maxRetriesOrOpts) {
  const opts = typeof maxRetriesOrOpts === 'number'
    ? { maxRetries: maxRetriesOrOpts, rateLimitWaitMs: 65000 }
    : { maxRetries: 5, rateLimitWaitMs: 65000, ...(maxRetriesOrOpts || {}) };
  const maxRetries = opts.maxRetries;
  const rateLimitWaitMs = opts.rateLimitWaitMs ?? 65000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await throttle();
      return await fn();
    } catch (error) {
      const msg = error.message || '';
      const status = error.status || error.httpStatusCode ||
        (msg.includes('429') ? 429 : msg.includes('503') ? 503 : null);
      const isRetryable = status === 429 || status >= 500 ||
        msg.includes('Resource has been exhausted') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('overloaded');

      if (isRetryable && attempt < maxRetries) {
        if (rateLimitWaitMs > 0) {
          console.log(`⏳ API error. Waiting ${rateLimitWaitMs / 1000}s... (attempt ${attempt}/${maxRetries})`);
          await new Promise(r => setTimeout(r, rateLimitWaitMs));
        }
      } else {
        throw error;
      }
    }
  }
}

/**
 * Call Gemini and parse JSON response, with automatic retry on parse failure
 * @param {string|Array} content - text prompt or multimodal parts (e.g. PDF + prompt)
 * @param {object} [apiRetryOptions] - passed to callWithRetry (e.g. { maxRetries: 1 } for job scoring)
 */
async function callGeminiWithJSONRetry(model, content, maxParseRetries = 2, apiRetryOptions = {}) {
  for (let attempt = 1; attempt <= maxParseRetries; attempt++) {
    const result = await callWithRetry(() => model.generateContent(content), apiRetryOptions);
    const text = result.response.text().trim();

    try {
      return safeParseJSON(text);
    } catch (parseError) {
      if (attempt < maxParseRetries) {
        console.log(`⚠️ JSON parse failed (attempt ${attempt}/${maxParseRetries}), retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.error('❌ JSON parse failed after all retries');
        throw parseError;
      }
    }
  }
}

/**
 * Safely parse JSON from Gemini response — handles truncated/malformed output
 */
function safeParseJSON(text) {
  // Step 1: Clean markdown wrappers
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Step 2: Extract JSON object/array
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;

  if (firstBrace === -1 && firstBracket === -1) {
    throw new Error('No JSON found in response');
  }

  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);

  text = text.substring(start);

  // Step 3: Try direct parse first
  try {
    return JSON.parse(text);
  } catch (e) {
    // Step 4: Try to repair truncated JSON
    console.log('⚠️ Attempting JSON repair...');
    console.log('⚠️ Raw response (first 500 chars):', text.substring(0, 500));
    let repaired = text;

    // Fix invalid escape sequences (e.g. \' which isn't valid in JSON)
    repaired = repaired.replace(/\\'/g, "'");

    // Remove trailing incomplete key-value pairs
    repaired = repaired.replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '');
    repaired = repaired.replace(/,\s*"[^"]*"\s*:\s*$/, '');
    repaired = repaired.replace(/,\s*"[^"]*$/, '');

    // Remove trailing incomplete objects/arrays
    repaired = repaired.replace(/,\s*\{[^}]*$/, '');
    repaired = repaired.replace(/,\s*\[[^\]]*$/, '');

    // Remove dangling commas before closing brackets
    repaired = repaired.replace(/,\s*([\]\}])/g, '$1');

    // Close any unclosed strings
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      // Find the last unmatched quote and close the value
      repaired += '"';
    }

    // Remove dangling commas again after quote fix
    repaired = repaired.replace(/,\s*([\]\}])/g, '$1');

    // Close unclosed arrays and objects (order matters: close inner first)
    const opens = { '{': 0, '[': 0 };
    const closes = { '}': '{', ']': '[' };
    let inString = false;
    let prevChar = '';
    for (const ch of repaired) {
      if (ch === '"' && prevChar !== '\\') inString = !inString;
      if (!inString) {
        if (ch in opens) opens[ch]++;
        if (ch in closes) opens[closes[ch]]--;
      }
      prevChar = ch;
    }
    for (let i = 0; i < opens['[']; i++) repaired += ']';
    for (let i = 0; i < opens['{']; i++) repaired += '}';

    try {
      return JSON.parse(repaired);
    } catch (e2) {
      console.error('JSON repair failed. Raw text:', text.substring(0, 500));
      throw new Error('AI returned invalid data. Please try again.');
    }
  }
}

/**
 * When Gemini rate-limits on skill extraction, derive a usable profile from resume text
 * so the pipeline can still search jobs without long retry waits.
 */
function heuristicSkillsProfile(resumeText) {
  const lower = resumeText.toLowerCase();

  // Large curated catalog of recognized tech skills, tools, and domain terms
  const catalog = [
    // Programming languages
    ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python'],
    ['java ', 'Java'], ['c++', 'C++'], ['c#', 'C#'], ['ruby', 'Ruby'], ['golang', 'Go'],
    ['rust', 'Rust'], ['php', 'PHP'], ['swift', 'Swift'], ['kotlin', 'Kotlin'],
    ['scala', 'Scala'], ['perl', 'Perl'], ['r programming', 'R'], ['matlab', 'MATLAB'],
    ['dart', 'Dart'], ['lua', 'Lua'], ['shell scripting', 'Shell Scripting'],
    ['objective-c', 'Objective-C'], ['haskell', 'Haskell'], ['elixir', 'Elixir'],
    // Frontend
    ['react', 'React'], ['angular', 'Angular'], ['vue', 'Vue.js'], ['next.js', 'Next.js'],
    ['nuxt', 'Nuxt.js'], ['svelte', 'Svelte'], ['jquery', 'jQuery'], ['bootstrap', 'Bootstrap'],
    ['tailwind', 'Tailwind CSS'], ['sass', 'SASS/SCSS'], ['webpack', 'Webpack'],
    ['vite', 'Vite'], ['redux', 'Redux'], ['zustand', 'Zustand'],
    // Backend
    ['node.js', 'Node.js'], ['express', 'Express.js'], ['django', 'Django'], ['flask', 'Flask'],
    ['spring boot', 'Spring Boot'], ['spring', 'Spring'], ['fastapi', 'FastAPI'],
    ['rails', 'Ruby on Rails'], ['laravel', 'Laravel'], ['asp.net', 'ASP.NET'],
    ['nest.js', 'NestJS'], ['nestjs', 'NestJS'], ['koa', 'Koa'],
    // Databases
    ['mongodb', 'MongoDB'], ['postgres', 'PostgreSQL'], ['postgresql', 'PostgreSQL'],
    ['mysql', 'MySQL'], ['redis', 'Redis'], ['sqlite', 'SQLite'], ['oracle', 'Oracle'],
    ['dynamodb', 'DynamoDB'], ['cassandra', 'Cassandra'], ['elasticsearch', 'Elasticsearch'],
    ['firebase', 'Firebase'], ['supabase', 'Supabase'], ['prisma', 'Prisma'],
    ['mongoose', 'Mongoose'], ['sequelize', 'Sequelize'],
    // Cloud & DevOps
    ['aws', 'AWS'], ['azure', 'Azure'], ['gcp', 'GCP'], ['docker', 'Docker'],
    ['kubernetes', 'Kubernetes'], ['terraform', 'Terraform'], ['jenkins', 'Jenkins'],
    ['ci/cd', 'CI/CD'], ['github actions', 'GitHub Actions'], ['gitlab', 'GitLab CI'],
    ['ansible', 'Ansible'], ['nginx', 'Nginx'], ['apache', 'Apache'],
    ['heroku', 'Heroku'], ['vercel', 'Vercel'], ['netlify', 'Netlify'],
    ['cloudflare', 'Cloudflare'],
    // Data & AI/ML
    ['machine learning', 'Machine Learning'], ['deep learning', 'Deep Learning'],
    ['artificial intelligence', 'AI'], ['openai', 'OpenAI'], ['nlp', 'NLP'],
    ['tensorflow', 'TensorFlow'], ['pytorch', 'PyTorch'], ['pandas', 'Pandas'],
    ['numpy', 'NumPy'], ['scikit-learn', 'Scikit-learn'], ['keras', 'Keras'],
    ['computer vision', 'Computer Vision'], ['data science', 'Data Science'],
    ['data analysis', 'Data Analysis'], ['tableau', 'Tableau'], ['power bi', 'Power BI'],
    ['jupyter', 'Jupyter'], ['hadoop', 'Hadoop'], ['spark', 'Apache Spark'],
    // Tools & Platforms
    ['git', 'Git'], ['github', 'GitHub'], ['jira', 'Jira'], ['confluence', 'Confluence'],
    ['figma', 'Figma'], ['postman', 'Postman'], ['swagger', 'Swagger'],
    ['n8n', 'n8n'], ['zapier', 'Zapier'], ['slack', 'Slack'],
    ['vs code', 'VS Code'], ['intellij', 'IntelliJ'],
    // Markup & Protocols
    ['html', 'HTML'], ['css', 'CSS'], ['graphql', 'GraphQL'], ['rest api', 'REST APIs'],
    ['websocket', 'WebSockets'], ['grpc', 'gRPC'], ['xml', 'XML'], ['json', 'JSON'],
    // Mobile
    ['react native', 'React Native'], ['flutter', 'Flutter'],
    ['android', 'Android Development'], ['ios development', 'iOS Development'],
    // Concepts & Methodologies
    ['microservices', 'Microservices'], ['agile', 'Agile'], ['scrum', 'Scrum'],
    ['kanban', 'Kanban'], ['devops', 'DevOps'], ['test driven', 'TDD'],
    ['unit testing', 'Unit Testing'], ['automation', 'Automation'],
    ['web scraping', 'Web Scraping'], ['scraping', 'Web Scraping'],
    ['data structures', 'Data Structures'], ['algorithms', 'Algorithms'],
    ['object oriented', 'Object-Oriented Programming'],
    ['design patterns', 'Design Patterns'], ['system design', 'System Design'],
    ['responsive design', 'Responsive Design'],
    // Other common tools & skills
    ['linux', 'Linux'], ['bash', 'Bash'], ['excel', 'Excel'],
    ['sql', 'SQL'], ['nosql', 'NoSQL'], ['socket.io', 'Socket.IO'],
    ['ejs', 'EJS'], ['handlebars', 'Handlebars'], ['pug', 'Pug'],
    ['jwt', 'JWT'], ['oauth', 'OAuth'], ['authentication', 'Authentication'],
    ['authorization', 'Authorization'], ['security', 'Security'],
    ['api development', 'API Development'], ['crud', 'CRUD Operations'],
    ['version control', 'Version Control'],
  ];

  const seen = new Set();
  const skills = [];
  for (const [needle, label] of catalog) {
    if (lower.includes(needle.trim()) && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      skills.push(label);
    }
  }

  // Only use catalog-matched skills — no raw chunk extraction (avoids phone numbers, garbage text)
  const expanded = skills.slice(0, 35);
  const roles = deriveRolesFromSkills(expanded);

  return {
    skills: expanded.slice(0, 18),
    expanded_skills: expanded,
    roles,
    experience: 'fresher',
    keywords: expanded.slice(0, 22)
  };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'was', 'were',
  'are', 'been', 'being', 'will', 'would', 'could', 'should', 'about', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'than', 'too', 'very',
  'can', 'just', 'now', 'our', 'you', 'your', 'they', 'them', 'their', 'she', 'him',
  'his', 'her', 'its', 'who', 'which', 'what', 'any', 'may', 'also', 'not', 'but', 'use',
  'used', 'using', 'work', 'worked', 'working', 'experience', 'years', 'year', 'month',
  'role', 'team', 'project', 'projects', 'company', 'skills', 'skill', 'ability',
  'including', 'included', 'well', 'strong', 'good', 'great', 'able', 'help', 'make',
  'made', 'new', 'via', 'per', 'etc', 'job', 'jobs', 'resume', 'summary', 'objective'
]);

function isStopTerm(term) {
  const lower = term.toLowerCase().trim();
  if (!lower || lower.length < 2) return true;
  if (STOP_WORDS.has(lower)) return true;
  if (lower.length <= 3 && !/^[a-z0-9+#.]+$/i.test(lower)) return true;
  return false;
}

function skillMatchesJobBlob(skill, blob) {
  const lower = skill.toLowerCase().trim();
  if (!lower) return false;
  if (blob.includes(lower)) return true;
  const words = lower.split(/[^a-z0-9+#.]+/i).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  if (words.length > 1) return words.every(w => blob.includes(w));
  return false;
}

/**
 * Build a skill list for local matching — prefer AI-extracted profile terms over raw resume tokens.
 */
function collectMatchSkills(profile, resumeText) {
  const seen = new Set();
  const out = [];

  const add = (label) => {
    const t = (label || '').trim();
    if (!t || isStopTerm(t)) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  if (profile) {
    [...(profile.skills || []), ...(profile.expanded_skills || []), ...(profile.keywords || []), ...(profile.roles || [])]
      .forEach(add);
  }

  if (out.length < 4) {
    const fallback = heuristicSkillsProfile(resumeText);
    [...(fallback.skills || []), ...(fallback.expanded_skills || []), ...(fallback.keywords || [])].forEach(add);
  }

  return out.slice(0, 35);
}

/**
 * Skill overlap when Gemini rate-limits — uses extracted profile skills, not raw stop-words.
 */
function heuristicJobMatches(resumeText, jobs, profile = null) {
  const skills = collectMatchSkills(profile, resumeText);

  return jobs.map(job => {
    const blob = `${job.title} ${job.company} ${(job.description || '').slice(0, 800)}`.toLowerCase();
    const matched = [];
    const missing = [];

    for (const skill of skills) {
      if (skillMatchesJobBlob(skill, blob)) {
        if (matched.length < 6) matched.push(skill);
      } else if (missing.length < 5) {
        missing.push(skill);
      }
    }

    const pool = Math.min(skills.length, 12);
    const ratio = pool > 0 ? matched.length / pool : 0;
    const m = Math.min(90, Math.max(22, Math.round(28 + ratio * 62)));

    const reason = skills.length > 0
      ? `Matched ${matched.length} of your listed skills to this role (estimated — retry shortly for full AI scoring).`
      : 'Limited keyword match while AI is busy. Wait a minute and upload again for detailed scoring.';

    return {
      title: job.title || 'Untitled',
      company: job.company || 'Unknown',
      description: job.description || '',
      match_percentage: m,
      matched_skills: matched,
      missing_skills: missing.slice(0, 5),
      reason,
      apply_url: job.apply_url || '#',
      salary: job.salary || 'Not specified'
    };
  }).sort((a, b) => b.match_percentage - a.match_percentage);
}

/**
 * Score resume against jobs. Returns matches only — profile comes from extractSkills
 * so the model does not re-emit a huge profile (avoids truncated JSON and 0 matches).
 */
async function analyzeResumeAndMatchJobs(resumeText, jobs, profile = null) {
  const key = getCacheKey(resumeText);
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log('📦 Using cached analysis');
    return cached.data;
  }

  const slice = jobs.slice(0, 12);
  const n = slice.length;

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    }
  });

  const jobSummaries = slice.map((job, i) => ({
    i,
    t: job.title,
    c: job.company,
    d: (job.description || '').substring(0, 60)
  }));

  const prompt = `You score how well each job listing fits the candidate's resume.

Resume:
"""
${resumeText.substring(0, 2500)}
"""

Jobs (use index i exactly as given):
${JSON.stringify(jobSummaries)}

Return ONLY valid JSON with this single key — do NOT include profile, skills lists, or any other keys:
{"matches":[{"i":0,"m":72,"ms":["a","b"],"xs":["c"],"r":"one short line"}]}

Rules:
- Output exactly ${n} objects in "matches", one per job above (every i from the list must appear once).
- m = integer 0–100 match score; sort the array by m descending.
- ms = up to 5 matched skill keywords; xs = up to 5 missing or weak areas.
- r = under 90 characters.

Keep the response compact.`;

  let parsed;
  try {
    // One API attempt per parse try — avoids 65s waits on 429; fallback fills in matches locally
    parsed = await callGeminiWithJSONRetry(model, prompt, 2, { maxRetries: 3, rateLimitWaitMs: 12000 });
  } catch (err) {
    console.warn('⚠️ Job scoring API unavailable, using skill-based estimates:', err.message || err);
    const data = { profile: null, matchedJobs: heuristicJobMatches(resumeText, slice, profile) };
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  const matchedJobs = (parsed.matches || [])
    .map(match => {
      const job = slice[match.i] || jobs[match.i] || {};
      return {
        title: job.title || 'Untitled',
        company: job.company || 'Unknown',
        description: job.description || '',
        match_percentage: Math.min(100, Math.max(0, parseInt(match.m, 10) || 0)),
        matched_skills: Array.isArray(match.ms) ? match.ms.slice(0, 8) : [],
        missing_skills: Array.isArray(match.xs) ? match.xs.slice(0, 8) : [],
        reason: (match.r || 'No analysis available').toString().slice(0, 500),
        apply_url: job.apply_url || '#',
        salary: job.salary || 'Not specified'
      };
    })
    .sort((a, b) => b.match_percentage - a.match_percentage);

  if (matchedJobs.length === 0 && n > 0) {
    console.warn('⚠️ AI returned no matches; using keyword estimates.');
    const data = { profile: null, matchedJobs: heuristicJobMatches(resumeText, slice, profile) };
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  const data = { profile: null, matchedJobs };
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

/**
 * Derive plausible job roles from a list of skills when Gemini doesn't return any.
 */
function deriveRolesFromSkills(skills) {
  const lower = skills.map(s => s.toLowerCase());
  const roles = [];
  const roleMap = [
    [['react', 'vue', 'angular', 'html', 'css', 'tailwind', 'frontend'], 'Frontend Developer'],
    [['node.js', 'express', 'django', 'flask', 'spring', 'backend', 'rest api'], 'Backend Developer'],
    [['react', 'node.js', 'mongodb', 'full stack', 'fullstack'], 'Full Stack Developer'],
    [['python', 'machine learning', 'tensorflow', 'pytorch', 'nlp', 'data science'], 'Data Scientist'],
    [['python', 'pandas', 'numpy', 'sql', 'data analysis', 'excel', 'tableau'], 'Data Analyst'],
    [['aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'devops', 'ci/cd'], 'DevOps Engineer'],
    [['java', 'spring', 'microservices'], 'Java Developer'],
    [['python', 'django', 'flask'], 'Python Developer'],
    [['swift', 'ios', 'xcode'], 'iOS Developer'],
    [['kotlin', 'android'], 'Android Developer'],
    [['flutter', 'react native', 'mobile'], 'Mobile Developer'],
    [['sql', 'mongodb', 'postgresql', 'mysql', 'database', 'redis'], 'Database Engineer'],
    [['figma', 'ui', 'ux', 'design'], 'UI/UX Designer'],
    [['c++', 'c#', 'rust', 'systems'], 'Software Engineer'],
  ];

  for (const [triggers, role] of roleMap) {
    if (triggers.some(t => lower.some(s => s.includes(t)))) {
      roles.push(role);
    }
  }

  if (roles.length === 0) {
    roles.push('Software Developer', 'Engineer');
  }

  // Deduplicate
  return [...new Set(roles)].slice(0, 5);
}

/**
 * Extract skills only (fallback when no jobs found)
 */
async function extractSkills(resumeText) {
  const key = 'skills_' + getCacheKey(resumeText);
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log('📦 Using cached skills');
    return cached.data;
  }

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    }
  });

  const prompt = `Analyze this resume and extract ALL of the following fields. Every field is REQUIRED and must be non-empty.

Resume:
"""
${resumeText.substring(0, 2500)}
"""

Return ONLY this JSON structure:
{"skills":["skill1","skill2"],"expanded_skills":["skill1","related1","skill2","related2"],"roles":["role1","role2"],"experience":"fresher","keywords":["keyword1","keyword2"]}

Field descriptions:
- skills: technical and soft skills explicitly mentioned (minimum 3).
- expanded_skills: all skills above PLUS closely related skills the candidate likely knows.
- roles: 2-5 job titles/roles the candidate is suited for based on their skills and experience (e.g. "Frontend Developer", "Full Stack Engineer", "Data Analyst"). NEVER leave this empty.
- experience: one of "fresher", "intermediate", or "experienced".
- keywords: 5-15 ATS-friendly search terms combining skills, tools, technologies, and domain terms from the resume. NEVER leave this empty.

IMPORTANT: "roles" and "keywords" MUST each contain at least 2 items. Infer roles from the skills if no explicit role is stated.

Do NOT include any text outside the JSON.`;

  let parsed;
  try {
    parsed = await callGeminiWithJSONRetry(model, prompt, 2, { maxRetries: 3, rateLimitWaitMs: 12000 });
  } catch (err) {
    console.warn('⚠️ Skills API unavailable, using local keyword extraction:', err.message || err);
    const data = heuristicSkillsProfile(resumeText);
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  let roles = Array.isArray(parsed.roles) ? parsed.roles.filter(Boolean) : [];
  let keywords = Array.isArray(parsed.keywords) ? parsed.keywords.filter(Boolean) : [];
  const skills = Array.isArray(parsed.skills) ? parsed.skills.filter(Boolean) : [];

  // Fallback: derive roles from skills if Gemini returned none
  if (roles.length === 0 && skills.length > 0) {
    roles = deriveRolesFromSkills(skills);
    console.log(`⚠️ Roles were empty — derived ${roles.length} roles from skills`);
  }

  // Fallback: derive keywords from skills if Gemini returned none
  if (keywords.length === 0 && skills.length > 0) {
    keywords = skills.slice(0, 15);
    console.log(`⚠️ Keywords were empty — using ${keywords.length} skills as keywords`);
  }

  const data = {
    skills,
    expanded_skills: parsed.expanded_skills || skills,
    roles,
    experience: parsed.experience || 'fresher',
    keywords
  };

  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

/**
 * When pdf-parse returns no text (image-only / odd encoding), send the PDF to Gemini
 * and extract the same profile fields plus resume_text for downstream job matching.
 */
async function extractSkillsFromPdfBuffer(pdfBuffer) {
  const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const key = 'pdf_skills_' + hash;
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log('📦 Using cached PDF skills');
    return cached.data;
  }

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    }
  });

  const prompt = `You are given a resume as a PDF. Read the document (including text in images if present).

Extract ALL of the following fields. Every field is REQUIRED and must be non-empty.
Also include resume_text: the full plain-text content of the resume for matching (truncate to about 4000 characters if extremely long).

Return ONLY this JSON structure:
{"skills":["skill1","skill2"],"expanded_skills":["skill1","related1"],"roles":["role1","role2"],"experience":"fresher","keywords":["keyword1","keyword2"],"resume_text":"plain text of the resume"}

Field descriptions:
- skills: technical and soft skills explicitly mentioned (minimum 3).
- expanded_skills: all skills above PLUS closely related skills the candidate likely knows.
- roles: 2-5 job titles/roles the candidate is suited for based on their skills and experience (e.g. "Frontend Developer", "Full Stack Engineer"). NEVER leave this empty.
- experience: one of "fresher", "intermediate", or "experienced".
- keywords: 5-15 ATS-friendly search terms. NEVER leave this empty.
- resume_text: the full plain-text content of the resume.

IMPORTANT: "roles" and "keywords" MUST each contain at least 2 items.

Do NOT include any text outside the JSON.`;

  const parts = [
    {
      inlineData: {
        mimeType: 'application/pdf',
        data: pdfBuffer.toString('base64')
      }
    },
    { text: prompt }
  ];

  let parsed;
  try {
    // PDF path has no plain text to heuristically parse — fail fast (no 65s×5 waits)
    parsed = await callGeminiWithJSONRetry(model, parts, 2, { maxRetries: 1, rateLimitWaitMs: 0 });
  } catch (err) {
    console.warn('⚠️ PDF skills API unavailable:', err.message || err);
    throw new Error(
      'AI could not read this PDF right now (often due to API rate limits). Wait one minute and try again, or export your resume as a text-based PDF.'
    );
  }

  const pdfSkills = Array.isArray(parsed.skills) ? parsed.skills.filter(Boolean) : [];
  let pdfRoles = Array.isArray(parsed.roles) ? parsed.roles.filter(Boolean) : [];
  let pdfKeywords = Array.isArray(parsed.keywords) ? parsed.keywords.filter(Boolean) : [];

  // Fallback: derive roles from skills if Gemini returned none
  if (pdfRoles.length === 0 && pdfSkills.length > 0) {
    pdfRoles = deriveRolesFromSkills(pdfSkills);
    console.log(`⚠️ PDF roles were empty — derived ${pdfRoles.length} roles from skills`);
  }

  // Fallback: derive keywords from skills if Gemini returned none
  if (pdfKeywords.length === 0 && pdfSkills.length > 0) {
    pdfKeywords = pdfSkills.slice(0, 15);
    console.log(`⚠️ PDF keywords were empty — using ${pdfKeywords.length} skills as keywords`);
  }

  const data = {
    skills: pdfSkills,
    expanded_skills: parsed.expanded_skills || pdfSkills,
    roles: pdfRoles,
    experience: parsed.experience || 'fresher',
    keywords: pdfKeywords,
    resume_text: typeof parsed.resume_text === 'string' ? parsed.resume_text : ''
  };

  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

/**
 * Basic bullet / line extraction for preprocessing (newline or leading -, •, *, numbers).
 */
function extractResumeBullets(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const bullets = [];
  for (const line of lines) {
    if (/^[-•*▪]\s*/.test(line) || /^\d+[.)]\s*/.test(line)) {
      bullets.push(line.replace(/^[-•*▪]\s*|^\d+[.)]\s*/, '').trim());
    }
  }
  if (bullets.length > 0) return bullets.slice(0, 25);
  return lines.filter(l => l.length > 12).slice(0, 15);
}

/**
 * Ask Gemini to suggest improved resume content aligned with a job description.
 */
async function improveResumeForJob(resumeText, jobDescription) {
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    }
  });

  const jobCtx = (jobDescription || '').slice(0, 8000);
  const resumeCtx = (resumeText || '').slice(0, 12000);

  const prompt = `You are an expert resume optimizer.

Rewrite the candidate's resume to better match the job description.

Rules:
- Keep all information truthful
- Do not add fake experience
- Improve wording using strong action verbs
- Optimize for ATS keywords
- Make it concise and professional

Job Description:
"""
${jobCtx}
"""

Resume:
"""
${resumeCtx}
"""

Return ONLY valid JSON with this exact structure (no markdown):
{
  "summary": "one or two sentence professional summary tailored to the job",
  "skills": ["skill phrases aligned with the job"],
  "experience": [
    { "original": "verbatim or paraphrased line from resume", "improved": "stronger ATS-friendly line" }
  ]
}

Include 5-15 experience items when possible: map each to a distinct resume bullet or phrase. If the resume has few bullets, merge short lines. Every "original" should reflect real content from the resume; "improved" must not invent employers, dates, or roles.`;

  const parsed = await callGeminiWithJSONRetry(model, prompt, 2, { maxRetries: 2, rateLimitWaitMs: 12000 });

  const experience = Array.isArray(parsed.experience) ? parsed.experience : [];
  const cleaned = experience
    .filter(item => item && (String(item.original || '').trim() || String(item.improved || '').trim()))
    .map(item => ({
      original: String(item.original || '').trim(),
      improved: String(item.improved || '').trim()
    }));

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    skills: Array.isArray(parsed.skills) ? parsed.skills.map(s => String(s).trim()).filter(Boolean) : [],
    experience: cleaned
  };
}

module.exports = {
  extractSkills,
  extractSkillsFromPdfBuffer,
  analyzeResumeAndMatchJobs,
  extractResumeBullets,
  improveResumeForJob
};

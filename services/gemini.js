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
  const catalog = [
    ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python'],
    ['java', 'Java'], ['c++', 'C++'], ['c#', 'C#'], ['ruby', 'Ruby'], ['golang', 'Go'],
    ['rust', 'Rust'], ['php', 'PHP'], ['swift', 'Swift'], ['kotlin', 'Kotlin'],
    ['react', 'React'], ['angular', 'Angular'], ['vue', 'Vue.js'], ['node.js', 'Node.js'],
    ['express', 'Express.js'], ['django', 'Django'], ['flask', 'Flask'],
    ['spring', 'Spring'], ['mongodb', 'MongoDB'], ['postgres', 'PostgreSQL'],
    ['postgresql', 'PostgreSQL'], ['mysql', 'MySQL'], ['redis', 'Redis'],
    ['aws', 'AWS'], ['azure', 'Azure'], ['gcp', 'GCP'], ['docker', 'Docker'],
    ['kubernetes', 'Kubernetes'], ['git', 'Git'],
    ['html', 'HTML'], ['css', 'CSS'], ['tailwind', 'Tailwind'], ['graphql', 'GraphQL'],
    ['machine learning', 'Machine Learning'], ['openai', 'OpenAI'], ['nlp', 'NLP'],
    ['tensorflow', 'TensorFlow'], ['pytorch', 'PyTorch'], ['pandas', 'Pandas'],
    ['numpy', 'NumPy'], ['n8n', 'n8n'], ['zapier', 'Zapier'], ['automation', 'Automation'],
    ['scraping', 'Web Scraping'], ['oracle', 'Oracle'],
    ['firebase', 'Firebase'], ['terraform', 'Terraform'], ['jenkins', 'Jenkins'],
    ['linux', 'Linux'], ['bash', 'Bash'], ['rest api', 'REST APIs'],
    ['microservices', 'Microservices'], ['agile', 'Agile'], ['scrum', 'Scrum'],
    ['excel', 'Excel']
  ];
  const seen = new Set();
  const skills = [];
  for (const [needle, label] of catalog) {
    if (lower.includes(needle.trim()) && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      skills.push(label);
    }
  }
  const chunks = resumeText.split(/[,•\n;|]+/).map(s => s.trim()).filter(s => s.length > 2 && s.length < 45);
  for (const c of chunks) {
    const k = c.toLowerCase();
    if (!seen.has(k) && /^[A-Za-z0-9+#.\s/&()\-]+$/.test(c)) {
      seen.add(k);
      skills.push(c);
    }
  }
  const expanded = skills.slice(0, 35);
  return {
    skills: expanded.slice(0, 18),
    expanded_skills: expanded,
    roles: ['Software Developer', 'Engineer'],
    experience: 'fresher',
    keywords: expanded.slice(0, 22)
  };
}

/**
 * Keyword overlap when Gemini rate-limits — still shows ranked jobs without another API call.
 */
function heuristicJobMatches(resumeText, jobs) {
  const resumeLower = resumeText.toLowerCase();
  const tokens = resumeLower
    .split(/[^a-z0-9+#.]+/i)
    .filter(t => t.length > 2)
    .slice(0, 120);

  return jobs.map(job => {
    const blob = `${job.title} ${job.company} ${(job.description || '').slice(0, 400)}`.toLowerCase();
    let hits = 0;
    const matched = [];
    for (const t of tokens) {
      if (blob.includes(t)) {
        hits++;
        if (matched.length < 6) matched.push(t);
      }
    }
    const denom = Math.max(12, Math.min(tokens.length, 40));
    const ratio = Math.min(1, hits / denom);
    const m = Math.min(92, Math.max(28, Math.round(32 + ratio * 58)));
    return {
      title: job.title || 'Untitled',
      company: job.company || 'Unknown',
      match_percentage: m,
      matched_skills: matched,
      missing_skills: [],
      reason: 'Estimated from resume vs job text (Gemini rate limit — refresh later for AI reasons).',
      apply_url: job.apply_url || '#',
      salary: job.salary || 'Not specified'
    };
  }).sort((a, b) => b.match_percentage - a.match_percentage);
}

/**
 * Score resume against jobs. Returns matches only — profile comes from extractSkills
 * so the model does not re-emit a huge profile (avoids truncated JSON and 0 matches).
 */
async function analyzeResumeAndMatchJobs(resumeText, jobs) {
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
    parsed = await callGeminiWithJSONRetry(model, prompt, 2, { maxRetries: 1, rateLimitWaitMs: 0 });
  } catch (err) {
    console.warn('⚠️ Job scoring API unavailable, using keyword estimates:', err.message || err);
    const data = { profile: null, matchedJobs: heuristicJobMatches(resumeText, slice) };
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  const matchedJobs = (parsed.matches || [])
    .map(match => {
      const job = slice[match.i] || jobs[match.i] || {};
      return {
        title: job.title || 'Untitled',
        company: job.company || 'Unknown',
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
    const data = { profile: null, matchedJobs: heuristicJobMatches(resumeText, slice) };
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  const data = { profile: null, matchedJobs };
  cache.set(key, { data, timestamp: Date.now() });
  return data;
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

  const prompt = `Extract skills, experience level, job roles, and keywords from this resume.

Resume:
"""
${resumeText.substring(0, 2500)}
"""

Return ONLY this JSON structure:
{"skills":["skill1","skill2"],"expanded_skills":["skill1","related1","skill2","related2"],"roles":["role1","role2"],"experience":"fresher","keywords":["keyword1","keyword2"]}

Do NOT include any text outside the JSON.`;

  let parsed;
  try {
    parsed = await callGeminiWithJSONRetry(model, prompt, 2, { maxRetries: 1, rateLimitWaitMs: 0 });
  } catch (err) {
    console.warn('⚠️ Skills API unavailable, using local keyword extraction:', err.message || err);
    const data = heuristicSkillsProfile(resumeText);
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  const data = {
    skills: parsed.skills || [],
    expanded_skills: parsed.expanded_skills || parsed.skills || [],
    roles: parsed.roles || [],
    experience: parsed.experience || 'fresher',
    keywords: parsed.keywords || []
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

Extract skills, experience level, job roles, and keywords. Also include resume_text: the full plain-text content of the resume for matching (truncate to about 4000 characters if extremely long).

Return ONLY this JSON structure:
{"skills":["skill1","skill2"],"expanded_skills":["skill1","related1"],"roles":["role1","role2"],"experience":"fresher","keywords":["keyword1","keyword2"],"resume_text":"plain text of the resume"}

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

  const data = {
    skills: parsed.skills || [],
    expanded_skills: parsed.expanded_skills || parsed.skills || [],
    roles: parsed.roles || [],
    experience: parsed.experience || 'fresher',
    keywords: parsed.keywords || [],
    resume_text: typeof parsed.resume_text === 'string' ? parsed.resume_text : ''
  };

  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

module.exports = { extractSkills, extractSkillsFromPdfBuffer, analyzeResumeAndMatchJobs };

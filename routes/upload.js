const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');

const { extractSkills, extractSkillsFromPdfBuffer, analyzeResumeAndMatchJobs } = require('../services/gemini');
const { fetchJobs, filterJobs } = require('../services/adzuna');

// Multer configuration — PDF only
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueName = `resume_${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// GET / — Render upload page
router.get('/', (req, res) => {
  res.render('index', { title: 'GROW.AI — Resume Analyzer' });
});

// POST /upload — Full pipeline
router.post('/upload', upload.single('resume'), async (req, res) => {
  let uploadedFilePath = null;

  try {
    if (!req.file) {
      return res.status(400).render('error', {
        title: 'Upload Error',
        message: 'No file uploaded. Please select a PDF resume.',
        details: null
      });
    }

    uploadedFilePath = req.file.path;
    console.log(`📄 Resume uploaded: ${req.file.originalname}`);

    // 1. Parse PDF
    const pdfBuffer = fs.readFileSync(uploadedFilePath);
    const pdfData = await pdfParse(pdfBuffer);
    const rawResumeText = typeof pdfData.text === 'string' ? pdfData.text : '';
    let resumeText = rawResumeText.replace(/\s+/g, ' ').trim();

    let profile;

    if (!resumeText) {
      console.log('📎 No embedded text in PDF; reading document with Gemini...');
      const fromPdf = await extractSkillsFromPdfBuffer(pdfBuffer);
      resumeText = (fromPdf.resume_text || '').replace(/\s+/g, ' ').trim();
      if (!resumeText) {
        resumeText = [...(fromPdf.skills || []), ...(fromPdf.roles || []), ...(fromPdf.keywords || [])]
          .filter(Boolean)
          .join('. ');
      }
      if (!resumeText.trim()) {
        throw new Error('Could not read this PDF. If it is a scanned image, try exporting a text-based PDF or use another file.');
      }
      profile = {
        skills: fromPdf.skills || [],
        expanded_skills: fromPdf.expanded_skills || fromPdf.skills || [],
        roles: fromPdf.roles || [],
        experience: fromPdf.experience || 'fresher',
        keywords: fromPdf.keywords || []
      };
      console.log(`📝 Gemini read ${resumeText.length} characters from PDF`);
      console.log(`✅ Profile from PDF (Gemini): ${profile.skills.length} skills, ${profile.roles.length} roles`);
    } else {
      if (resumeText.length < 50) {
        console.warn(`⚠️ Low extracted text length (${resumeText.length}). Continuing with best-effort analysis.`);
      }

      console.log(`📝 Extracted ${resumeText.length} characters from resume`);

      // 2. STEP 1: Extract skills with Gemini FIRST (this already works reliably)
      console.log('🤖 Step 1: AI extracting skills from resume...');
      profile = await extractSkills(resumeText);
      console.log(`✅ Skills extracted: ${profile.skills.length} skills, ${profile.roles.length} roles`);
    }

    console.log(`   Skills: ${profile.skills.slice(0, 8).join(', ')}...`);
    console.log(`   Roles: ${profile.roles.join(', ')}`);

    // 3. STEP 2: Search Adzuna using AI-extracted skills + roles
    let allJobs = [];
    let filteredJobs = [];

    try {
      console.log('🔍 Step 2: Fetching job listings using AI-extracted skills...');

      // Build smart search queries from AI-extracted data
      const searchSkills = buildSearchQuery(profile);
      console.log(`🔎 Search keywords: ${searchSkills.join(', ')}`);

      allJobs = await fetchJobs(searchSkills);
      console.log(`📋 Found ${allJobs.length} jobs from Adzuna`);

      if (allJobs.length === 0) {
        // Retry with broader terms using roles
        console.log('⚠️ No jobs found, retrying with role-based search...');
        const roleKeywords = profile.roles
          .slice(0, 3)
          .map(r => r.replace(/[^a-zA-Z\s]/g, '').trim())
          .filter(r => r.length > 2);

        if (roleKeywords.length > 0) {
          allJobs = await fetchJobs(roleKeywords);
          console.log(`📋 Role-based search found ${allJobs.length} jobs`);
        }
      }

      if (allJobs.length === 0) {
        // Last resort: try with just the top 2 core skills
        console.log('⚠️ Still no jobs, trying broad skill search...');
        const broadSkills = profile.skills
          .filter(s => s.length > 2 && !s.includes(' '))
          .slice(0, 2);
        if (broadSkills.length > 0) {
          allJobs = await fetchJobs(broadSkills);
          console.log(`📋 Broad search found ${allJobs.length} jobs`);
        }
      }

      // Pre-filter jobs using expanded skills
      if (allJobs.length > 0) {
        filteredJobs = filterJobs(allJobs, profile.expanded_skills || profile.skills);
        console.log(`🎯 ${filteredJobs.length} jobs matched after skill filtering`);

        // If filter was too aggressive, use all jobs
        if (filteredJobs.length === 0) {
          filteredJobs = allJobs.slice(0, 20);
          console.log(`↩️ Using ${filteredJobs.length} unfiltered jobs`);
        }
      }
    } catch (adzunaErr) {
      console.warn('⚠️ Adzuna failed, continuing without jobs:', adzunaErr.message);
    }

    // 4. STEP 3: If we have jobs, use Gemini to score matches
    let matchedJobs = [];

    if (filteredJobs.length > 0) {
      console.log(`🧠 Step 3: AI scoring ${Math.min(filteredJobs.length, 12)} job matches...`);
      const result = await analyzeResumeAndMatchJobs(resumeText, filteredJobs);
      // Merge the AI-scored profile with the original skills profile
      // (the scoring call may return additional insights)
      if (result.profile) {
        profile.skills = mergeUnique(profile.skills, result.profile.skills || []);
        profile.roles = mergeUnique(profile.roles, result.profile.roles || []);
        profile.keywords = mergeUnique(profile.keywords, result.profile.keywords || []);
      }
      matchedJobs = result.matchedJobs;
      console.log(`✅ Done! ${matchedJobs.length} job matches scored`);
    } else {
      console.log('ℹ️ No jobs available to score — showing skills profile only');
    }

    // 5. Cleanup & render
    cleanupFile(uploadedFilePath);

    res.render('results', {
      title: 'Your Resume Analysis — GROW.AI',
      profile,
      jobs: matchedJobs,
      totalJobsFound: allJobs.length,
      filteredCount: filteredJobs.length
    });

  } catch (error) {
    console.error('Pipeline error:', error.message);
    cleanupFile(uploadedFilePath);

    let userMessage = 'An unexpected error occurred. Please try again.';
    const msg = error.message || '';

    if (msg.includes('429') || msg.includes('RATE_LIMIT') || msg.includes('Resource has been exhausted') || msg.includes('RESOURCE_EXHAUSTED')) {
      userMessage = 'AI service is temporarily busy. Please wait 60 seconds and try again — your request will work on the next attempt.';
    } else if (msg.includes('invalid data') || msg.includes('JSON')) {
      userMessage = 'AI returned an unexpected format. Please try again — this is usually a one-time glitch.';
    } else if (msg.includes('not extract enough text')) {
      userMessage = msg;
    }

    res.status(500).render('error', {
      title: 'Analysis Error',
      message: userMessage,
      details: null
    });
  }
});

/**
 * Build search terms from AI-extracted profile.
 * Returns a combined array of skills + roles — the Adzuna service
 * handles building smart queries internally.
 */
function buildSearchQuery(profile) {
  const skills = profile.skills || [];
  const roles = profile.roles || [];
  const keywords = profile.keywords || [];

  // Combine skills + roles + keywords, prioritizing skills first
  const combined = [
    ...skills,
    ...roles,
    ...keywords
  ].filter(s => s && s.trim().length > 1);

  // Deduplicate (case-insensitive)
  const seen = new Set();
  const unique = combined.filter(s => {
    const lower = s.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });

  if (unique.length === 0) {
    return ['developer'];
  }

  return unique;
}

/**
 * Merge two arrays keeping unique values (case-insensitive)
 */
function mergeUnique(arr1, arr2) {
  const seen = new Set(arr1.map(s => s.toLowerCase()));
  const result = [...arr1];
  for (const item of arr2) {
    if (!seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      result.push(item);
    }
  }
  return result;
}

function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
  }
}

module.exports = router;

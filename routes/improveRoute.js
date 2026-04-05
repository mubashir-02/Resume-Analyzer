const express = require('express');
const router = express.Router();
const { improveResumeForJob, extractResumeBullets } = require('../services/gemini');

router.post('/improve-resume', async (req, res) => {
  try {
    const { resumeText, jobDescription } = req.body || {};

    if (!resumeText || typeof resumeText !== 'string' || !resumeText.trim()) {
      return res.status(400).json({ error: 'resumeText is required' });
    }
    if (jobDescription == null || typeof jobDescription !== 'string') {
      return res.status(400).json({ error: 'jobDescription is required' });
    }
    const trimmedDesc = jobDescription.trim();
    if (!trimmedDesc) {
      return res.status(400).json({ error: 'jobDescription cannot be empty' });
    }

    const trimmedResume = resumeText.trim();
    const bulletCandidates = extractResumeBullets(trimmedResume);

    const result = await improveResumeForJob(trimmedResume, trimmedDesc);
    let improvements = Array.isArray(result.experience) ? result.experience : [];

    if (improvements.length === 0 && bulletCandidates.length > 0) {
      improvements = bulletCandidates.map(original => ({ original, improved: original }));
    }

    res.json({
      summary: result.summary || '',
      skills: result.skills || [],
      improvements,
      bullets: improvements
    });
  } catch (err) {
    console.error('Improve resume error:', err);
    const msg = err.message || String(err);
    const busy = /429|RATE_LIMIT|RESOURCE_EXHAUSTED|Resource has been exhausted/i.test(msg);
    res.status(busy ? 503 : 500).json({
      error: busy ? 'AI is busy. Please try again in a moment.' : 'Failed to improve resume.',
      details: process.env.NODE_ENV === 'development' ? msg : undefined
    });
  }
});

module.exports = router;

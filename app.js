require('dotenv').config();

// Local dev only (Windows/antivirus TLS issues). Never enable in production.
if (process.env.SSL_INSECURE_DEV === 'true') {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ SSL_INSECURE_DEV is ignored in production. Fix system CA certs instead.');
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn('⚠️ SSL certificate verification disabled (SSL_INSECURE_DEV=true). Local dev only.');
  }
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = process.env.UPLOAD_DIR || (
  process.env.VERCEL ? path.join(os.tmpdir(), 'uploads') : path.join(__dirname, 'uploads')
);
process.env.UPLOAD_DIR = uploadsDir;
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Favicon (browsers auto-request /favicon.ico)
app.get('/favicon.ico', (req, res) => {
  res.type('image/svg+xml');
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/login', (req, res) => {
  res.render('login', { title: 'Grow — AI Talent Acquisition' });
});

// Routes
const uploadRoutes = require('./routes/upload');
const improveRoute = require('./routes/improveRoute');
app.use('/', uploadRoutes);
app.use('/', improveRoute);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).render('error', {
    title: 'Server Error',
    message: 'Something went wrong. Please try again.',
    details: process.env.NODE_ENV === 'development' ? err.message : null
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
  console.log(`\n🚀 GROW.AI Resume Analyzer running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;

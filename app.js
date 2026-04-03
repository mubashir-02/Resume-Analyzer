require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Routes
const uploadRoutes = require('./routes/upload');
app.use('/', uploadRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).render('error', {
    title: 'Server Error',
    message: 'Something went wrong. Please try again.',
    details: process.env.NODE_ENV === 'development' ? err.message : null
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 GROW.AI Resume Analyzer running at http://localhost:${PORT}\n`);
});

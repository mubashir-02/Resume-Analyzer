const cloudinary = require('cloudinary').v2;

function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function configureCloudinary() {
  if (!isCloudinaryConfigured()) return false;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  return true;
}

/**
 * Upload a resume PDF buffer to Cloudinary (raw file).
 * @returns {{ url: string, publicId: string, bytes: number }}
 */
async function uploadResumePdf(buffer, originalName = 'resume.pdf') {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid PDF buffer for Cloudinary upload');
  }
  if (!configureCloudinary()) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in .env');
  }

  const safeBase = (originalName || 'resume')
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 48) || 'resume';

  const folder = process.env.CLOUDINARY_FOLDER || 'grow-ai/resumes';

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        folder,
        public_id: `${safeBase}_${Date.now()}`,
        format: 'pdf',
        type: 'upload'
      },
      (error, uploadResult) => {
        if (error) reject(error);
        else resolve(uploadResult);
      }
    );
    stream.end(buffer);
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    bytes: result.bytes
  };
}

module.exports = { uploadResumePdf, isCloudinaryConfigured };

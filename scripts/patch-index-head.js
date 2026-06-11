const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../views/index.ejs');
let html = fs.readFileSync(file, 'utf8');

const replacement = `    <link rel="stylesheet" href="/css/dashboard-utilities.css">
    <link rel="stylesheet" href="/css/dashboard-components.css">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link
        href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&f[]=clash-display@400,500,600,700&display=swap"
        rel="stylesheet">

    <script>
        function applyTailwindConfig() {
            if (typeof tailwind === 'undefined') return;
            tailwind.config = {
                theme: {
                    extend: {
                        fontFamily: {
                            sans: ['Satoshi', 'Inter', 'sans-serif'],
                            display: ['Clash Display', 'Satoshi', 'sans-serif'],
                        },
                        colors: {
                            bg: { primary: '#0f0f0f', secondary: '#1a1a1a', tertiary: '#242424' },
                            warm: {
                                50: '#fafaf9', 100: '#f5f5f4', 200: '#e7e5e4', 300: '#d6d3d1',
                                400: '#a8a29e', 500: '#78716c', 600: '#57534e', 700: '#44403c',
                                800: '#292524', 900: '#1c1917',
                            },
                            coral: {
                                50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af',
                                400: '#fb7185', 500: '#f43f5e', 600: '#e11d48',
                            },
                            sage: {
                                50: '#f6f7f6', 100: '#e3e7e3', 200: '#c7d2c7', 300: '#a3b5a3',
                                400: '#7a947a', 500: '#5c7a5c', 600: '#486148',
                            },
                            sand: {
                                50: '#fdfbf7', 100: '#f7f3e8', 200: '#efe5d0',
                                300: '#e6d5b8', 400: '#d4b896',
                            }
                        },
                        animation: {
                            'float': 'float 6s ease-in-out infinite',
                            'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                            'shimmer': 'shimmer 2.5s linear infinite',
                            'gradient-x': 'gradient-x 8s ease infinite',
                            'fade-in': 'fadeIn 0.6s ease-out forwards',
                            'slide-up': 'slideUp 0.8s ease-out forwards',
                        },
                        keyframes: {
                            float: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-20px)' } },
                            shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
                            'gradient-x': { '0%, 100%': { 'background-position': '0% 50%' }, '50%': { 'background-position': '100% 50%' } },
                            fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
                            slideUp: { '0%': { opacity: '0', transform: 'translateY(30px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } }
                        }
                    }
                }
            };
        }
        var twScript = document.querySelector('script[src*="tailwindcss"]');
        if (twScript) twScript.addEventListener('load', applyTailwindConfig);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyTailwindConfig);
        } else {
            applyTailwindConfig();
        }
    </script>`;

const updated = html.replace(
  /<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>[\s\S]*?<\/style>/,
  replacement
);

if (updated === html) {
  console.error('Patch failed — pattern not found');
  process.exit(1);
}

fs.writeFileSync(file, updated);
console.log('Patched views/index.ejs head');

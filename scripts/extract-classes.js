const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../views/index.ejs'), 'utf8');
const classes = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g)) {
  m[1].split(/\s+/).forEach(c => {
    if (!c.includes('<%')) classes.add(c);
  });
}
console.log([...classes].sort().join('\n'));

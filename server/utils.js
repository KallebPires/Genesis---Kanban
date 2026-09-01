const COLORS = ['#0B71F5', '#2ECC8F', '#B07CFF', '#F5A70B', '#FF7A86'];

function pickColor(seed) {
  return COLORS[seed % COLORS.length];
}

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function initialsFromName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts[1] ? parts[1][0] : '')).toUpperCase() || '—';
}

module.exports = { pickColor, randomColor, initialsFromName };

// server/games/flags.js
// The country list behind Guess the Flag.

const RAW = [
  ["us", "United States", 1, "usa", "america", "united states of america", "u s a"],
  ["gb", "United Kingdom", 1, "uk", "britain", "great britain", "england"],
  ["fr", "France", 1],
  ["de", "Germany", 1],
  ["it", "Italy", 1],
  ["es", "Spain", 1],
  ["pt", "Portugal", 1],
  ["nl", "Netherlands", 1, "holland"],
  ["be", "Belgium", 1],
  ["ch", "Switzerland", 1],
  ["at", "Austria", 1],
  ["se", "Sweden", 1],
  ["no", "Norway", 1],
  ["fi", "Finland", 1],
  ["dk", "Denmark", 1],
  ["ie", "Ireland", 1],
  ["pl", "Poland", 1],
  ["gr", "Greece", 1],
  ["ru", "Russia", 1],
  ["ua", "Ukraine", 1],
  ["tr", "Turkey", 1, "turkiye", "türkiye"],
  ["cn", "China", 1],
  ["jp", "Japan", 1],
  ["kr", "South Korea", 1, "korea", "republic of korea"],
  ["in", "India", 1],
  ["pk", "Pakistan", 1],
  ["br", "Brazil", 1],
  ["ar", "Argentina", 1],
  ["mx", "Mexico", 1],
  ["ca", "Canada", 1],
  ["au", "Australia", 1],
  ["nz", "New Zealand", 1],
  ["za", "South Africa", 1],
  ["eg", "Egypt", 1],
  ["ng", "Nigeria", 1],
  ["ke", "Kenya", 1],
  ["il", "Israel", 1],
  ["sa", "Saudi Arabia", 1],
  ["ir", "Iran", 1],
  ["iq", "Iraq", 1],
  ["id", "Indonesia", 1],
  ["th", "Thailand", 1],
  ["vn", "Vietnam", 1],
  ["ph", "Philippines", 1],
  ["jm", "Jamaica", 1],
  ["cu", "Cuba", 1],
  ["cl", "Chile", 1],
  ["co", "Colombia", 1],
  ["pe", "Peru", 1],

  ["af", "Afghanistan", 2],
  ["al", "Albania", 2],
  ["dz", "Algeria", 2],
  ["ao", "Angola", 2],
  ["am", "Armenia", 2],
  ["az", "Azerbaijan", 2],
  ["bd", "Bangladesh", 2],
  ["by", "Belarus", 2],
  ["bo", "Bolivia", 2],
  ["ba", "Bosnia and Herzegovina", 2, "bosnia"],
  ["bg", "Bulgaria", 2],
  ["kh", "Cambodia", 2],
  ["cm", "Cameroon", 2],
  ["cr", "Costa Rica", 2],
  ["hr", "Croatia", 2],
  ["cy", "Cyprus", 2],
  ["cz", "Czechia", 2, "czech republic"],
  ["do", "Dominican Republic", 2],
  ["ec", "Ecuador", 2],
  ["ee", "Estonia", 2],
  ["et", "Ethiopia", 2],
  ["ge", "Georgia", 2],
  ["gh", "Ghana", 2],
  ["gt", "Guatemala", 2],
  ["hn", "Honduras", 2],
  ["hu", "Hungary", 2],
  ["is", "Iceland", 2],
  ["jo", "Jordan", 2],
  ["kz", "Kazakhstan", 2],
  ["kw", "Kuwait", 2],
  ["lv", "Latvia", 2],
  ["lb", "Lebanon", 2],
  ["ly", "Libya", 2],
  ["lt", "Lithuania", 2],
  ["lu", "Luxembourg", 2],
  ["my", "Malaysia", 2],
  ["mt", "Malta", 2],
  ["ma", "Morocco", 2],
  ["mm", "Myanmar", 2, "burma"],
  ["np", "Nepal", 2],
  ["kp", "North Korea", 2, "dprk"],
  ["om", "Oman", 2],
  ["pa", "Panama", 2],
  ["py", "Paraguay", 2],
  ["qa", "Qatar", 2],
  ["ro", "Romania", 2],
  ["rs", "Serbia", 2],
  ["sg", "Singapore", 2],
  ["sk", "Slovakia", 2],
  ["si", "Slovenia", 2],
  ["lk", "Sri Lanka", 2],
  ["sd", "Sudan", 2],
  ["sy", "Syria", 2],
  ["tw", "Taiwan", 2],
  ["tz", "Tanzania", 2],
  ["tn", "Tunisia", 2],
  ["ug", "Uganda", 2],
  ["ae", "United Arab Emirates", 2, "uae", "emirates"],
  ["uy", "Uruguay", 2],
  ["uz", "Uzbekistan", 2],
  ["ve", "Venezuela", 2],
  ["ye", "Yemen", 2],
  ["zw", "Zimbabwe", 2],
  ["zm", "Zambia", 2],
  ["sn", "Senegal", 2],
  ["so", "Somalia", 2],
  ["md", "Moldova", 2],
  ["mn", "Mongolia", 2],
  ["ps", "Palestine", 2],
  ["pr", "Puerto Rico", 2],
  ["hk", "Hong Kong", 2],
  ["gl", "Greenland", 2],
  ["mc", "Monaco", 2],
  ["va", "Vatican City", 2, "vatican", "holy see"],
  ["ci", "Ivory Coast", 2, "cote d ivoire", "côte d'ivoire", "cote divoire"],
  ["cd", "DR Congo", 2, "democratic republic of the congo", "congo kinshasa", "drc", "zaire"],

  ["ad", "Andorra", 3],
  ["ag", "Antigua and Barbuda", 3, "antigua"],
  ["bs", "Bahamas", 3],
  ["bh", "Bahrain", 3],
  ["bb", "Barbados", 3],
  ["bz", "Belize", 3],
  ["bj", "Benin", 3],
  ["bt", "Bhutan", 3],
  ["bw", "Botswana", 3],
  ["bn", "Brunei", 3],
  ["bf", "Burkina Faso", 3],
  ["bi", "Burundi", 3],
  ["cv", "Cape Verde", 3, "cabo verde"],
  ["cf", "Central African Republic", 3],
  ["td", "Chad", 3],
  ["km", "Comoros", 3],
  ["cg", "Republic of the Congo", 3, "congo", "congo brazzaville"],
  ["dj", "Djibouti", 3],
  ["dm", "Dominica", 3],
  ["gq", "Equatorial Guinea", 3],
  ["er", "Eritrea", 3],
  ["sz", "Eswatini", 3, "swaziland"],
  ["fj", "Fiji", 3],
  ["ga", "Gabon", 3],
  ["gm", "Gambia", 3],
  ["gd", "Grenada", 3],
  ["gn", "Guinea", 3],
  ["gw", "Guinea-Bissau", 3],
  ["gy", "Guyana", 3],
  ["ht", "Haiti", 3],
  ["ki", "Kiribati", 3],
  ["kg", "Kyrgyzstan", 3],
  ["la", "Laos", 3],
  ["ls", "Lesotho", 3],
  ["lr", "Liberia", 3],
  ["li", "Liechtenstein", 3],
  ["mg", "Madagascar", 3],
  ["mw", "Malawi", 3],
  ["mv", "Maldives", 3],
  ["ml", "Mali", 3],
  ["mh", "Marshall Islands", 3],
  ["mr", "Mauritania", 3],
  ["mu", "Mauritius", 3],
  ["fm", "Micronesia", 3],
  ["me", "Montenegro", 3],
  ["mz", "Mozambique", 3],
  ["na", "Namibia", 3],
  ["nr", "Nauru", 3],
  ["ni", "Nicaragua", 3],
  ["ne", "Niger", 3],
  ["mk", "North Macedonia", 3, "macedonia"],
  ["pw", "Palau", 3],
  ["pg", "Papua New Guinea", 3],
  ["rw", "Rwanda", 3],
  ["kn", "Saint Kitts and Nevis", 3, "st kitts and nevis", "saint kitts"],
  ["lc", "Saint Lucia", 3, "st lucia"],
  ["vc", "Saint Vincent and the Grenadines", 3, "st vincent", "saint vincent"],
  ["ws", "Samoa", 3],
  ["sm", "San Marino", 3],
  ["st", "Sao Tome and Principe", 3, "são tomé and príncipe", "sao tome"],
  ["sc", "Seychelles", 3],
  ["sl", "Sierra Leone", 3],
  ["sb", "Solomon Islands", 3],
  ["ss", "South Sudan", 3],
  ["sr", "Suriname", 3],
  ["tj", "Tajikistan", 3],
  ["tl", "Timor-Leste", 3, "east timor"],
  ["tg", "Togo", 3],
  ["to", "Tonga", 3],
  ["tt", "Trinidad and Tobago", 3, "trinidad"],
  ["tm", "Turkmenistan", 3],
  ["tv", "Tuvalu", 3],
  ["vu", "Vanuatu", 3],
  ["xk", "Kosovo", 3],
  ["ax", "Aland Islands", 3, "åland islands", "aland"],
  ["fo", "Faroe Islands", 3, "faroes"],
  ["gi", "Gibraltar", 3],
  ["je", "Jersey", 3],
  ["im", "Isle of Man", 3],
  ["bm", "Bermuda", 3],
  ["ky", "Cayman Islands", 3],
  ["aw", "Aruba", 3],
  ["cw", "Curacao", 3, "curaçao"],
  ["pf", "French Polynesia", 3],
  ["nc", "New Caledonia", 3],
  ["mo", "Macau", 3, "macao"],
];

const COUNTRIES = RAW.map(([code, name, tier, ...aliases]) => ({
  code,
  name,
  tier,
  aliases,
}));

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|of|republic|islands?|and)\b/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function keysFor(c) {
  const out = new Set([normalize(c.name)]);
  for (const a of c.aliases) out.add(normalize(a));
  return [...out].filter(Boolean);
}

const ANSWERS = new Map();
for (const c of COUNTRIES) for (const k of keysFor(c)) if (!ANSWERS.has(k)) ANSWERS.set(k, c.code);

function within(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [];
  for (let i = 0; i <= a.length; i++) rows.push(new Array(b.length + 1).fill(0));
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    rows[i][0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, rows[i - 2][j - 2] + 1);
      rows[i][j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
  }
  return rows[a.length][b.length];
}

function slackFor(len) {
  if (len < 6) return 0;
  if (len < 9) return 1;
  return 2;
}

function nearCodes(k) {
  const slack = slackFor(k.length);
  if (!slack) return [];
  const hits = new Set();
  for (const [key, code] of ANSWERS) {
    if (Math.abs(key.length - k.length) > slack) continue;
    if (within(k, key, slack) <= slack) hits.add(code);
  }
  return [...hits];
}

function matches(guess, code) {
  const k = normalize(guess);
  if (!k) return false;
  if (ANSWERS.get(k) === code) return true;
  if (ANSWERS.has(k)) return false;
  const near = nearCodes(k);
  return near.length === 1 && near[0] === code;
}

function isNearMiss(guess, code) {
  const k = normalize(guess);
  if (!k || ANSWERS.has(k)) return false;
  const near = nearCodes(k);
  return near.length > 1 && near.includes(code);
}

function isAnyCountry(guess) {
  const k = normalize(guess);
  return !!k && ANSWERS.has(k);
}

module.exports = {
  COUNTRIES,
  BY_CODE,
  normalize,
  matches,
  isNearMiss,
  isAnyCountry,
  _within: within,
  _nearCodes: nearCodes,
};

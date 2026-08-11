/**
 * Renders the profile stat cards as SVG files committed into this repo.
 *
 * The cards used to be hotlinked from github-readme-stats.vercel.app, whose
 * shared instance is rate limited across every user on GitHub -- so the images
 * regularly failed to load and the README showed broken-image alt text instead.
 * Generating them here means they are served from this repository and cannot
 * break because somebody else exhausted a quota.
 *
 * Uses only the GitHub GraphQL API and the workflow's built-in GITHUB_TOKEN;
 * there is no third-party service and no personal access token to rotate.
 */

const LOGIN = process.env.GH_LOGIN ?? "shashvat-singham";
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

// tokyonight, matching the theme the hotlinked cards used.
const THEME = {
  bg: "#1a1b27",
  title: "#70a5fd",
  text: "#38bdae",
  icon: "#bf91f3",
  border: "#1a1b27",
};

const MAX_LANGS = 8;

// Card geometry, shared so the languages card can pad itself to match the
// stats card and the two line up in the README without a height attribute.
const CARD_PADDING = 60;
const ROW_HEIGHT = 25;

async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stat-cards",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.errors) {
    throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

/** Repos are paginated because the totals must not silently truncate at 100. */
async function fetchProfile() {
  const query = `
    query ($login: String!, $cursor: String) {
      user(login: $login) {
        name
        createdAt
        followers { totalCount }
        pullRequests { totalCount }
        issues { totalCount }
        repositoriesContributedTo(
          contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
        ) { totalCount }
        repositories(
          first: 100
          after: $cursor
          ownerAffiliations: OWNER
          isFork: false
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            stargazerCount
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name color } }
            }
          }
        }
      }
    }`;

  let cursor = null;
  let user = null;
  const repos = [];

  do {
    const data = await graphql(query, { login: LOGIN, cursor });
    user = data.user;
    repos.push(...user.repositories.nodes);
    cursor = user.repositories.pageInfo.hasNextPage
      ? user.repositories.pageInfo.endCursor
      : null;
  } while (cursor);

  return { user, repos };
}

/**
 * contributionsCollection only covers a one-year window, so all-time commits
 * need one query per year since the account was created.
 */
async function fetchAllTimeCommits(createdAt) {
  const query = `
    query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          restrictedContributionsCount
        }
      }
    }`;

  const startYear = new Date(createdAt).getUTCFullYear();
  const endYear = new Date().getUTCFullYear();
  let total = 0;

  for (let year = startYear; year <= endYear; year++) {
    const data = await graphql(query, {
      login: LOGIN,
      from: `${year}-01-01T00:00:00Z`,
      to: `${year}-12-31T23:59:59Z`,
    });
    const c = data.user.contributionsCollection;
    total += c.totalCommitContributions + c.restrictedContributionsCount;
  }

  return total;
}

const escapeXml = (s) =>
  String(s).replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]
  );

const formatNumber = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

/** Shared <style> block; the fade keeps the cards feeling like the old ones. */
function styles() {
  return `
    .title { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.title}; }
    .label { font: 400 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
    .value { font: 600 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
    .icon  { fill: ${THEME.icon}; }
    .fade  { opacity: 0; animation: fadein 0.5s ease-in-out forwards; }
    @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      .fade { opacity: 1; animation: none; }
    }
  `;
}

function statsCard(rows, heading) {
  const width = 495;
  const height = CARD_PADDING + rows.length * ROW_HEIGHT;

  const body = rows
    .map(
      (r, i) => `
      <g class="fade" transform="translate(25, ${62 + i * 25})" style="animation-delay: ${
        i * 100 + 150
      }ms">
        <text class="label" x="0" y="0">${escapeXml(r.label)}:</text>
        <text class="value" x="330" y="0" text-anchor="end">${escapeXml(r.value)}</text>
      </g>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(
    heading
  )}">
  <style>${styles()}</style>
  <rect width="${width - 1}" height="${
    height - 1
  }" x="0.5" y="0.5" rx="6" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text class="title" x="25" y="35">${escapeXml(heading)}</text>
  ${body}
</svg>
`;
}

function languagesCard(langs, heading, height) {
  const width = 300;
  const rows = Math.ceil(langs.length / 2);
  // Padded to the stats card's height so the two sit level in the README
  // without needing a height attribute that would rescale them unevenly.
  const contentBottom = 75 + rows * 20;
  const offset = Math.max(0, (height - contentBottom) / 2);

  const total = langs.reduce((sum, l) => sum + l.size, 0) || 1;

  // Stacked bar. Offsets accumulate so the segments butt up against each other.
  let x = 0;
  const bar = langs
    .map((l) => {
      const w = (l.size / total) * 250;
      const seg = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(
        2
      )}" height="8" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join("");

  const legend = langs
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const pct = ((l.size / total) * 100).toFixed(2);
      return `
      <g class="fade" transform="translate(${col * 125}, ${row * 20})" style="animation-delay: ${
        i * 80 + 150
      }ms">
        <circle cx="5" cy="6" r="5" fill="${l.color}"/>
        <text class="label" x="16" y="10">${escapeXml(l.name)} ${pct}%</text>
      </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(
    heading
  )}">
  <style>${styles()}
    .label { font: 400 11px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
  </style>
  <rect width="${width - 1}" height="${
    height - 1
  }" x="0.5" y="0.5" rx="6" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text class="title" x="25" y="35">${escapeXml(heading)}</text>
  <g transform="translate(25, ${50 + offset})">
    <mask id="bar"><rect x="0" y="0" width="250" height="8" rx="4" fill="#fff"/></mask>
    <g mask="url(#bar)">${bar}</g>
  </g>
  <g transform="translate(25, ${75 + offset})">${legend}</g>
</svg>
`;
}

function topLanguages(repos) {
  const totals = new Map();

  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      const { name, color } = edge.node;
      const prev = totals.get(name);
      totals.set(name, {
        name,
        // GitHub omits colors for a few languages; grey keeps the bar readable.
        color: color ?? "#858585",
        size: (prev?.size ?? 0) + edge.size,
      });
    }
  }

  return [...totals.values()].sort((a, b) => b.size - a.size).slice(0, MAX_LANGS);
}

/**
 * Every contribution day since the account was created.
 *
 * contributionCalendar is capped at one year per query, same as the commit
 * totals above, so this walks year by year and merges the days into one map.
 */
async function fetchContributionDays(createdAt) {
  const query = `
    query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`;

  const startYear = new Date(createdAt).getUTCFullYear();
  const endYear = new Date().getUTCFullYear();
  const days = new Map();

  for (let year = startYear; year <= endYear; year++) {
    const data = await graphql(query, {
      login: LOGIN,
      from: `${year}-01-01T00:00:00Z`,
      to: `${year}-12-31T23:59:59Z`,
    });
    for (const week of data.user.contributionsCollection.contributionCalendar
      .weeks) {
      for (const day of week.contributionDays) {
        // Years overlap at the edges; the later query wins, which is the one
        // with the settled count.
        days.set(day.date, day.contributionCount);
      }
    }
  }

  return days;
}

const ONE_DAY = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * Total, current and longest streak from the day map.
 *
 * Today counts only if something was contributed; an empty today does not
 * break the streak, because the day is not over yet. That is what the old
 * hotlinked card did, and breaking someone's streak at 00:01 UTC would be
 * both wrong and demoralising.
 */
function streakFrom(days) {
  const dates = [...days.keys()].sort();
  if (dates.length === 0) {
    return { total: 0, current: 0, longest: 0, currentFrom: null, currentTo: null };
  }

  let total = 0;
  for (const n of days.values()) total += n;

  let longest = 0;
  let run = 0;
  let previous = null;
  for (const date of dates) {
    const count = days.get(date);
    if (count > 0) {
      const consecutive =
        previous !== null &&
        Date.parse(date) - Date.parse(previous) === ONE_DAY;
      run = consecutive ? run + 1 : 1;
      longest = Math.max(longest, run);
      previous = date;
    } else {
      run = 0;
      previous = null;
    }
  }

  const today = isoDay(new Date());
  let cursor = new Date(`${today}T00:00:00Z`);
  if ((days.get(today) ?? 0) === 0) cursor = new Date(cursor.getTime() - ONE_DAY);

  let current = 0;
  let currentTo = null;
  let currentFrom = null;
  while ((days.get(isoDay(cursor)) ?? 0) > 0) {
    currentTo ??= isoDay(cursor);
    currentFrom = isoDay(cursor);
    current += 1;
    cursor = new Date(cursor.getTime() - ONE_DAY);
  }

  return { total, current, longest, currentFrom, currentTo };
}

const prettyDate = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "";

/** Three columns, with the current streak ringed in the middle. */
function streakCard(s) {
  const width = 495;
  const height = 195;
  const third = width / 3;

  const column = (i, value, label, sub) => `
    <g class="fade" transform="translate(${third * i + third / 2}, 0)" style="animation-delay: ${
    i * 120 + 150
  }ms">
      <text class="streak-num" x="0" y="72" text-anchor="middle">${escapeXml(value)}</text>
      <text class="streak-label" x="0" y="100" text-anchor="middle">${escapeXml(label)}</text>
      <text class="streak-sub" x="0" y="122" text-anchor="middle">${escapeXml(sub)}</text>
    </g>`;

  const range =
    s.currentFrom && s.currentTo
      ? s.currentFrom === s.currentTo
        ? prettyDate(s.currentTo)
        : `${prettyDate(s.currentFrom)} - ${prettyDate(s.currentTo)}`
      : "-";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitHub contribution streak">
  <style>${styles()}
    .streak-num   { font: 700 28px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
    .streak-big   { font: 700 28px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.icon}; }
    .streak-label { font: 700 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.title}; }
    .streak-sub   { font: 400 11px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; opacity: 0.75; }
  </style>
  <rect width="${width - 1}" height="${height - 1}" x="0.5" y="0.5" rx="6" fill="${THEME.bg}" stroke="${THEME.border}"/>
  ${column(0, formatNumber(s.total), "Total Contributions", "All time")}
  <g class="fade" transform="translate(${third + third / 2}, 0)" style="animation-delay: 270ms">
    <circle cx="0" cy="62" r="42" fill="none" stroke="${THEME.icon}" stroke-width="4"/>
    <text class="streak-big" x="0" y="72" text-anchor="middle">${s.current}</text>
    <text class="streak-label" x="0" y="128" text-anchor="middle">Current Streak</text>
    <text class="streak-sub" x="0" y="150" text-anchor="middle">${escapeXml(range)}</text>
  </g>
  ${column(2, formatNumber(s.longest), "Longest Streak", "Days in a row")}
  <line x1="${third}" y1="42" x2="${third}" y2="152" stroke="${THEME.text}" stroke-opacity="0.2"/>
  <line x1="${third * 2}" y1="42" x2="${third * 2}" y2="152" stroke="${THEME.text}" stroke-opacity="0.2"/>
</svg>
`;
}

async function main() {
  const { user, repos } = await fetchProfile();
  const commits = await fetchAllTimeCommits(user.createdAt);

  const stars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);
  const displayName = (user.name ?? LOGIN).split(" ")[0];

  const rows = [
    { label: "Total Stars Earned", value: formatNumber(stars) },
    { label: "Total Commits", value: formatNumber(commits) },
    { label: "Total PRs", value: formatNumber(user.pullRequests.totalCount) },
    { label: "Total Issues", value: formatNumber(user.issues.totalCount) },
    {
      label: "Contributed to",
      value: formatNumber(user.repositoriesContributedTo.totalCount),
    },
    { label: "Followers", value: formatNumber(user.followers.totalCount) },
  ];

  const streak = streakFrom(await fetchContributionDays(user.createdAt));

  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir("assets", { recursive: true });

  const cardHeight = CARD_PADDING + rows.length * ROW_HEIGHT;

  await writeFile(
    "assets/github-stats.svg",
    statsCard(rows, `${displayName}'s GitHub Stats`)
  );
  await writeFile(
    "assets/top-languages.svg",
    languagesCard(topLanguages(repos), "Most Used Languages", cardHeight)
  );

  await writeFile("assets/streak.svg", streakCard(streak));

  console.log(
    `stars=${stars} commits=${commits} repos=${repos.length} ` +
      `streak=${streak.current} longest=${streak.longest} total=${streak.total}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "LuciusChen";
const token = process.env.GITHUB_TOKEN;
const now = new Date();
const year = now.getUTCFullYear();
const from = `${year}-01-01T00:00:00Z`;
const to = now.toISOString();

const graphqlQuery = `
  query ProfileData(
    $login: String!
    $after: String
    $from: DateTime!
    $to: DateTime!
  ) {
    user(login: $login) {
      followers {
        totalCount
      }
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
      }
      repositories(
        first: 100
        after: $after
        ownerAffiliations: OWNER
        privacy: PUBLIC
        isFork: false
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

const restHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "LuciusChen-profile-card-generator",
};

if (token) {
  restHeaders.Authorization = `Bearer ${token}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${data.message || response.statusText}`);
  }

  return data;
}

async function graphql(variables) {
  if (token) {
    const result = await fetchJson("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        ...restHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: graphqlQuery, variables }),
    });

    if (result.errors?.length) {
      throw new Error(result.errors.map((error) => error.message).join("; "));
    }

    return result.data;
  }

  const args = ["api", "graphql", "-f", `query=${graphqlQuery}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== null && value !== undefined) {
      args.push("-F", `${key}=${value}`);
    }
  }

  const result = JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }),
  );

  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }

  return result.data;
}

async function rest(path) {
  if (token) {
    return fetchJson(`https://api.github.com${path}`, { headers: restHeaders });
  }

  return JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

async function getProfileData() {
  const languages = new Map();
  let after = null;
  let profile;

  do {
    const data = await graphql({ login: username, after, from, to });
    if (!data.user) {
      throw new Error(`GitHub user ${username} was not found`);
    }

    profile ??= data.user;
    const repositories = data.user.repositories;

    for (const repository of repositories.nodes) {
      for (const { size, node } of repository.languages.edges) {
        const current = languages.get(node.name) || {
          name: node.name,
          color: node.color || "#8b949e",
          size: 0,
        };
        current.size += size;
        languages.set(node.name, current);
      }
    }

    after = repositories.pageInfo.hasNextPage
      ? repositories.pageInfo.endCursor
      : null;
  } while (after);

  const account = await rest(`/users/${encodeURIComponent(username)}`);
  const repositories = await getOwnedRepositories();
  const totalStars = repositories.reduce(
    (sum, repository) => sum + repository.stargazers_count,
    0,
  );

  return {
    contributions: profile.contributionsCollection,
    followers: profile.followers.totalCount,
    languages: [...languages.values()].sort((a, b) => b.size - a.size),
    publicRepos: account.public_repos,
    totalStars,
  };
}

async function getOwnedRepositories() {
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const batch = await rest(
      `/users/${encodeURIComponent(username)}/repos?type=owner&sort=full_name&per_page=100&page=${page}`,
    );
    repositories.push(...batch);

    if (batch.length < 100) {
      return repositories;
    }
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function renderStatsCard(data) {
  const metrics = [
    ["Total Stars", data.totalStars],
    ["Public Repos", data.publicRepos],
    [`Commits (${year})`, data.contributions.totalCommitContributions],
    [`Pull Requests (${year})`, data.contributions.totalPullRequestContributions],
    [`Issues (${year})`, data.contributions.totalIssueContributions],
    ["Followers", data.followers],
  ];

  const metricRows = metrics
    .map(([label, value], index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const labelX = column === 0 ? 28 : 288;
      const valueX = column === 0 ? 238 : 498;
      const y = 82 + row * 38;

      return `<g>
      <circle cx="${labelX}" cy="${y - 5}" r="4" fill="#38bdae"/>
      <text x="${labelX + 12}" y="${y}" class="label">${escapeXml(label)}</text>
      <text x="${valueX}" y="${y}" text-anchor="end" class="value">${formatNumber(value)}</text>
    </g>`;
    })
    .join("\n  ");

  return `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="526"
  height="190"
  viewBox="0 0 526 190"
  role="img"
  aria-labelledby="stats-title stats-desc"
>
  <title id="stats-title">${escapeXml(username)}'s GitHub stats</title>
  <desc id="stats-desc">Public GitHub statistics updated automatically.</desc>
  <style>
    .title { font: 600 18px "Segoe UI", Ubuntu, sans-serif; fill: #70a5fd; }
    .label { font: 400 14px "Segoe UI", Ubuntu, sans-serif; fill: #a9b1d6; }
    .value { font: 600 14px "Segoe UI", Ubuntu, sans-serif; fill: #c0caf5; }
    .updated { font: 400 11px "Segoe UI", Ubuntu, sans-serif; fill: #565f89; }
  </style>
  <rect x="0.5" y="0.5" width="525" height="189" rx="6" fill="#1a1b27" stroke="#30363d"/>
  <text x="26" y="36" class="title">${escapeXml(username)}'s GitHub Stats</text>
  <path d="M26 51H500" stroke="#30363d"/>
  ${metricRows}
  <text x="500" y="178" text-anchor="end" class="updated">Updated ${now.toISOString().slice(0, 10)} UTC</text>
</svg>
`;
}

function renderLanguagesCard(languages) {
  const visible = languages.slice(0, 6);
  const total = languages.reduce((sum, language) => sum + language.size, 0);

  if (!visible.length || total === 0) {
    throw new Error("No public repository language data was returned");
  }

  let barX = 26;
  const barWidth = 308;
  const segments = visible
    .map((language) => {
      const width = (language.size / total) * barWidth;
      const segment = `<rect x="${barX.toFixed(2)}" y="58" width="${width.toFixed(2)}" height="8" fill="${escapeXml(language.color)}"/>`;
      barX += width;
      return segment;
    })
    .join("");

  const languageRows = visible
    .map((language, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column === 0 ? 28 : 190;
      const y = 99 + row * 30;
      const percentage = ((language.size / total) * 100).toFixed(1);

      return `<g>
      <circle cx="${x}" cy="${y - 5}" r="5" fill="${escapeXml(language.color)}"/>
      <text x="${x + 12}" y="${y}" class="language">${escapeXml(language.name)}</text>
      <text x="${x + 146}" y="${y}" text-anchor="end" class="percentage">${percentage}%</text>
    </g>`;
    })
    .join("\n  ");

  return `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="360"
  height="190"
  viewBox="0 0 360 190"
  role="img"
  aria-labelledby="languages-title languages-desc"
>
  <title id="languages-title">${escapeXml(username)}'s top languages</title>
  <desc id="languages-desc">Languages used across public, owned, non-fork repositories.</desc>
  <style>
    .title { font: 600 18px "Segoe UI", Ubuntu, sans-serif; fill: #70a5fd; }
    .language { font: 600 12px "Segoe UI", Ubuntu, sans-serif; fill: #a9b1d6; }
    .percentage { font: 400 11px "Segoe UI", Ubuntu, sans-serif; fill: #787c99; }
    .updated { font: 400 11px "Segoe UI", Ubuntu, sans-serif; fill: #565f89; }
  </style>
  <rect x="0.5" y="0.5" width="359" height="189" rx="6" fill="#1a1b27" stroke="#30363d"/>
  <text x="26" y="36" class="title">Most Used Languages</text>
  <defs>
    <clipPath id="language-bar">
      <rect x="26" y="58" width="308" height="8" rx="4"/>
    </clipPath>
  </defs>
  <g clip-path="url(#language-bar)">
    <rect x="26" y="58" width="308" height="8" fill="#30363d"/>
    ${segments}
  </g>
  ${languageRows}
  <text x="334" y="178" text-anchor="end" class="updated">Updated ${now.toISOString().slice(0, 10)} UTC</text>
</svg>
`;
}

const data = await getProfileData();
await mkdir("profile", { recursive: true });
await Promise.all([
  writeFile("profile/stats.svg", renderStatsCard(data), "utf8"),
  writeFile("profile/top-langs.svg", renderLanguagesCard(data.languages), "utf8"),
]);

console.log(`Generated profile cards for ${username}.`);

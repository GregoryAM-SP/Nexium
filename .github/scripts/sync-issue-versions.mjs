#!/usr/bin/env node
// Keeps the "Nexium version" dropdown in the bug report form in sync with the
// published releases, so the template never has to be edited by hand when a new
// version ships. GitHub issue forms cannot fetch data at render time, so the
// workflow rewrites the options between the markers in bug_report.yml.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const START = "# <nexium-versions:start>";
const END = "# <nexium-versions:end>";
const MAX_OPTIONS = 20;

const templatePath =
  process.argv[2] ?? ".github/ISSUE_TEMPLATE/bug_report.yml";
const repo = process.env.GITHUB_REPOSITORY;

function api(path) {
  // Offline/test seam: set NEXIUM_VERSIONS_JSON to a JSON array of releases or
  // tags to exercise the rewrite without calling GitHub.
  const fixture = process.env.NEXIUM_VERSIONS_JSON;
  if (fixture) {
    return JSON.parse(fixture);
  }
  const output = execFileSync(
    "gh",
    ["api", `${path}?per_page=100`, "--paginate", "--slurp"],
    { encoding: "utf8", env: process.env },
  );
  return JSON.parse(output).flat();
}

function versionKey(tag) {
  return tag
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}

function compareDesc(a, b) {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] ?? 0) - (left[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function collectVersions() {
  if (!repo && !process.env.NEXIUM_VERSIONS_JSON) {
    throw new Error("GITHUB_REPOSITORY is not set.");
  }
  const seen = new Set();
  const versions = [];
  const add = (label) => {
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    versions.push(label);
  };

  try {
    for (const release of api(`repos/${repo}/releases`)) {
      if (release.draft) continue;
      const tag = String(release.tag_name ?? "").trim();
      if (!tag) continue;
      add(release.prerelease ? `${tag} (pre-release)` : tag);
    }
  } catch (error) {
    console.error(`Could not read releases: ${error.message}`);
  }

  if (versions.length === 0) {
    // Repositories without releases still have tags worth listing.
    try {
      for (const tag of api(`repos/${repo}/tags`)) {
        add(String(tag.name ?? "").trim());
      }
    } catch (error) {
      console.error(`Could not read tags: ${error.message}`);
    }
  }

  return versions.sort(compareDesc).slice(0, MAX_OPTIONS);
}

function main() {
  const versions = collectVersions();
  if (versions.length === 0) {
    console.log("No releases or tags found; leaving the template untouched.");
    return;
  }

  const source = readFileSync(templatePath, "utf8");
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Version markers not found in ${templatePath}.`);
  }

  // Replace only the lines between the markers so their own indentation, and
  // every other line of the form, stay untouched.
  const startLineEnd = source.indexOf("\n", start + START.length);
  const endLineStart = source.lastIndexOf("\n", end);
  if (startLineEnd === -1 || endLineStart === -1 || endLineStart < startLineEnd) {
    throw new Error(`Version markers are malformed in ${templatePath}.`);
  }

  const block = versions.map((version) => `        - ${version}`).join("\n");
  const updated =
    source.slice(0, startLineEnd + 1) +
    `${block}\n` +
    source.slice(endLineStart + 1);

  if (updated === source) {
    console.log("Version dropdown is already current.");
    return;
  }
  writeFileSync(templatePath, updated);
  console.log(`Updated ${versions.length} version options in ${templatePath}.`);
}

main();

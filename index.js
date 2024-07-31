const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Octokit } = require('@octokit/rest');
const { context } = require('@actions/github');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function getChangedFiles() {
  const prNumber = context.payload.pull_request.number;
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
  });

  return files.map(file => file.filename);
}

function isServiceFolder(folderPath) {
  return fs.existsSync(path.join(folderPath, 'routes'));
}

function getRouteFiles(folderPath) {
  let routeFiles = [];
  const items = fs.readdirSync(folderPath, { withFileTypes: true });

  for (const item of items) {
    const itemPath = path.join(folderPath, item.name);
    if (item.isDirectory()) {
      if (item.name !== 'lambda' && isServiceFolder(itemPath)) {
        const routesPath = path.join(itemPath, 'routes');
        routeFiles = routeFiles.concat(getRouteFiles(routesPath));
      } else {
        routeFiles = routeFiles.concat(getRouteFiles(itemPath));
      }
    } else if (item.isFile() && item.name.endsWith('.js')) {
      routeFiles.push(itemPath);
    }
  }

  return routeFiles;
}

function detectRoutesInFile(filePath, changedLines) {
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n');
  let routerVariable = null;
  let insideRoute = false;
  let startLine = 0;
  let routeContent = '';
  const routes = [];

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];

    if (!routerVariable) {
      const match = line.match(/const\s+(\w+)\s*=\s*express\.Router\(\)/);
      if (match) {
        routerVariable = match[1];
      }
    }

    if (routerVariable) {
      const routePattern = new RegExp(`^\\s*${routerVariable}\\.`);
      if (routePattern.test(line) && !insideRoute) {
        insideRoute = true;
        startLine = lineNumber + 1;
        routeContent = `${line}\n`;

        // Check if the route is a single-line route
        if (line.trim().endsWith(');')) {
          const endLine = lineNumber + 1;
          routes.push({
            startLine,
            endLine,
            code: routeContent.trim(),
            type: 'single-line',
          });
          insideRoute = false;
          routeContent = '';
        }
      } else if (insideRoute) {
        routeContent += `${line}\n`;
        if (line.trim() === ');' || line.includes(');')) {
          const endLine = lineNumber + 1;
          routes.push({
            startLine,
            endLine,
            code: routeContent.trim(),
            type: 'multi-line',
          });
          insideRoute = false;
          routeContent = '';
        }
      }
    }
  }

  if (insideRoute) {
    routes.push({
      startLine,
      endLine: lines.length,
      code: routeContent.trim(),
      type: 'incomplete',
    });
  }

  return routes.filter(route => changedLines.some(line => line >= route.startLine && line <= route.endLine));
}

async function main() {
  const rootPath = 'service';
  const changedFiles = await getChangedFiles();

  console.log(changedFiles);

  for (const file of changedFiles) {
    console.log(file, rootPath);
    if (file.startsWith(rootPath) && file.includes('routes') && file.endsWith('.js')) {
      const diffOutput = execSync(`git diff --unified=0 HEAD~1 HEAD ${file}`).toString();
      const changedLines = diffOutput
        .split('\n')
        .filter(line => line.startsWith('@@'))
        .flatMap(line => {
          const match = line.match(/\+(\d+)(,\d+)?/);
          if (match) {
            const start = parseInt(match[1], 10);
            const count = match[2] ? parseInt(match[2].substring(1), 10) : 1;
            return Array.from({ length: count }, (_, i) => start + i);
          }
          return [];
        });

      console.log(changedLines);

      const routes = detectRoutesInFile(file, changedLines);

      console.log(routes);

      if (routes.length > 0) {
        for (const route of routes) {
          const comment = `Route change detected:\n\`\`\`javascript\n${route.code}\n\`\`\``;

          await octokit.rest.pulls.createReviewComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.payload.pull_request.number,
            body: comment,
            path: file,
            line: route.startLine,
            side: 'RIGHT',
          });
        }
      }
    }
  }
}

main();

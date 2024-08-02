const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Octokit } = require('@octokit/rest');
const { context } = require('@actions/github');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const COMMENT_FILE_PATH = process.env.INPUT_COMMENT_CONTENT_FILE;

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

async function getDiffHunks(filePath) {
  const diffOutput = execSync(`git diff --unified=0 HEAD~1 HEAD ${filePath}`).toString();
  const diffHunks = diffOutput.split('\n').filter(line => line.startsWith('@@')).map(hunk => {
    const match = hunk.match(/@@ \-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    return {
      originalStart: parseInt(match[1], 10),
      newStart: parseInt(match[2], 10),
    };
  });

  return diffHunks;
}

function findDiffHunkLineNumber(diffHunks, targetLine) {
  for (const hunk of diffHunks) {
    if (targetLine >= hunk.newStart) {
      return targetLine - hunk.newStart + hunk.originalStart;
    }
  }
  return null;
}

function getCommentingLines(routes, changedLines) {
  const commentingLines = [];
  changedLines.sort().forEach((line) => {
    routes.forEach((route, index) => {
      if (route.selectedLine == undefined && line >= route.startLine && line <= route.endLine) {
        routes[index]['selectedLine'] = line;
        commentingLines.push(line);
      }
    });
  });
  return commentingLines;
}

async function getExistingComments(owner, repo, pullNumber, botUsername) {
  const { data: comments } = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: pullNumber,
  });

  return comments.filter(comment => comment.user.login === botUsername);
}

async function addPRComments(commentingLines, file, existingComments, commentBody) {
  let commentAdded = false;
  if (commentingLines.length > 0) {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
    });

    for (const line of commentingLines) {
      const existingComment = existingComments.find(comment => comment.path === file && comment.original_line === line);
      if (!existingComment) {
        await octokit.rest.pulls.createReviewComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: context.payload.pull_request.number,
          body: commentBody,
          commit_id: pr.head.sha,
          path: file,
          line: line,
          side: 'RIGHT',
        });

        commentAdded = true;

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  return { commentAdded };
}

async function getCommentBody() {
  // Default comment body
  let commentBody = `
  ### Route Changed
  - [ ] Fully reviewed all the configuration changes and fully aware the effect of the route
  `;

  try {
    commentBody = fs.readFileSync(COMMENT_FILE_PATH, 'utf8');
  } catch (error) {
    console.error('👿 Unable to read comment content file. Using default comment body.');
  }

  return commentBody;
}

async function addLabelIfNotExists(owner, repo, prNumber, labelName, labelColor) {
  const { data: { labels } } = await octokit.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  });

  const labelExists = labels.some(label => label.name === labelName);

  if (!labelExists) {
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      pull_number: prNumber,
      labels: [labelName],
    });
  }
}

async function main() {
  const rootPath = 'service';
  const changedFiles = await getChangedFiles();

  const botUsername = 'github-actions[bot]';

  // Configure Git user
  try {
    execSync('git config --global user.email "action@github.com"');
    execSync('git config --global user.name "GitHub Action"');
  } catch (error) {
    console.error(`👿 Error setting Git config: ${error.message}`);
  }

  const commentBody = await getCommentBody();

  let commentAdded = false;

  for (const file of changedFiles) {
    if (file.startsWith(rootPath) && file.includes('routes') && file.endsWith('.js')) {
      const diffHunks = await getDiffHunks(file);
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

      const routes = detectRoutesInFile(file, changedLines);
      const commentingLines = getCommentingLines(routes, changedLines);

      const existingComments = await getExistingComments(context.repo.owner, context.repo.repo, context.payload.pull_request.number, botUsername);

      const status = await addPRComments(commentingLines, file, existingComments, commentBody);
      commentAdded = commentAdded || status.commentAdded;
    }
  }

  if (commentAdded) {
    // Request changes after adding comments
    await octokit.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      event: 'REQUEST_CHANGES',
      body: 'Please address the comments related to the route changes.',
    });

    // Add 'routes-changed' label with red color
    await addLabelIfNotExists(context.repo.owner, context.repo.repo, context.payload.pull_request.number, 'routes-changed', 'ff0000');
  }
}

main();

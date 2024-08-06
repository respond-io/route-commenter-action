/**
 * @fileoverview This GitHub Action script detects changes in route files within a monorepo,
 * adds comments to the PR where route changes are detected, and requests changes if necessary.
 * It also adds a specific label to the PR if route changes are found.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Octokit } = require('@octokit/rest');
const { context } = require('@actions/github');

// Constants
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const COMMENT_FILE_PATH = process.env.INPUT_COMMENT_CONTENT_FILE;
const TAG_NAME = process.env.INPUT_TAG_NAME || 'change-route';

const octokit = new Octokit({ auth: GITHUB_TOKEN });

/**
 * Gets the list of changed files in the pull request.
 * @returns {Promise<string[]>} - An array of filenames that have been changed.
 */
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

/**
 * Checks if the specified folder is a service folder by looking for a 'routes' subfolder.
 * @param {string} folderPath - The path of the folder to check.
 * @returns {boolean} - True if the folder is a service folder, false otherwise.
 */
function isServiceFolder(folderPath) {
  return fs.existsSync(path.join(folderPath, 'routes'));
}

/**
 * Recursively gets all route files in the specified folder.
 * @param {string} folderPath - The path of the folder to search for route files.
 * @returns {string[]} - An array of paths to the route files.
 */
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

/**
 * Detects the routes in the specified file that have changed based on the changed lines.
 * @param {string} filePath - The path to the file to analyze.
 * @param {number[]} changedLines - An array of line numbers that have changed in the file.
 * @returns {Object[]} - An array of route objects that have changed.
 */
async function detectRoutesInFile(filePath, changedLines, type = 'modified') {
  let data = '';
  if (type === 'modified') {
    data = fs.readFileSync(filePath, 'utf8');
  } else if (type === 'deleted') {
    console.log({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: filePath,
      ref: context.payload.pull_request.base.ref
    });
    const fileContent = await octokit.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: filePath,
      ref: context.payload.pull_request.base.ref
    });
    console.log('fileContent', fileContent);
    data = Buffer.from(fileContent.data.content, 'base64').toString('utf8');
  }
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

/**
 * Gets the diff hunks for the specified file.
 * @param {string} filePath - The path to the file to get the diff hunks for.
 * @returns {Promise<Object[]>} - An array of diff hunk objects.
 */
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

/**
 * Finds the corresponding line number in the original file for the specified target line in the diff hunks.
 * @param {Object[]} diffHunks - An array of diff hunk objects.
 * @param {number} targetLine - The target line number in the diff hunks.
 * @returns {number|null} - The corresponding line number in the original file, or null if not found.
 */
function findDiffHunkLineNumber(diffHunks, targetLine) {
  for (const hunk of diffHunks) {
    if (targetLine >= hunk.newStart) {
      return targetLine - hunk.newStart + hunk.originalStart;
    }
  }
  return null;
}

/**
 * Gets the lines that need to be commented on based on the detected routes and changed lines.
 * @param {Object[]} routes - An array of route objects.
 * @param {number[]} changedLines - An array of changed line numbers.
 * @returns {number[]} - An array of line numbers to be commented on.
 */
function getCommentingLines(routes, changedLines) {
  const commentingLines = [];
  changedLines.sort().forEach((line) => {
    routes.forEach((route, index) => {
      if (route.selectedLine === undefined && line >= route.startLine && line <= route.endLine) {
        routes[index]['selectedLine'] = line;
        commentingLines.push(line);
      }
    });
  });
  return commentingLines;
}

/**
 * Gets the existing comments made by the bot in the pull request.
 * @param {string} owner - The owner of the repository.
 * @param {string} repo - The name of the repository.
 * @param {number} pullNumber - The pull request number.
 * @param {string} botUsername - The username of the bot.
 * @returns {Promise<Object[]>} - An array of existing comment objects.
 */
async function getExistingComments(owner, repo, pullNumber, botUsername) {
  const { data: comments } = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: pullNumber,
  });

  return comments.filter(comment => comment.user.login === botUsername);
}

/**
 * Adds comments to the pull request for the specified lines and file.
 * @param {number[]} commentingLines - An array of line numbers to comment on.
 * @param {string} file - The path to the file to comment on.
 * @param {Object[]} existingComments - An array of existing comment objects.
 * @param {string} commentBody - The body of the comment to add.
 * @returns {Promise<Object>} - An object indicating whether a comment was added.
 */
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

/**
 * Gets the body of the comment from the specified file or returns a default comment body.
 * @returns {Promise<string>} - The body of the comment.
 */
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

/**
 * Adds a label to the pull request if it does not already exist.
 * @param {string} owner - The owner of the repository.
 * @param {string} repo - The name of the repository.
 * @param {number} prNumber - The pull request number.
 * @param {string} labelName - The name of the label to add.
 * @returns {Promise<void>}
 */
async function addLabelIfNotExists(owner, repo, prNumber, labelName) {
  const { data: { labels } } = await octokit.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  });

  const labelExists = labels.some(label => label.name === labelName);

  if (!labelExists) {
    await octokit.rest.issues.setLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [labelName],
    });
  }
}

/**
 * Main function to execute the GitHub Action.
 * @returns {Promise<void>}
 */
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

      const deletedLines = diffOutput
        .split('\n')
        .filter(line => line.startsWith('@@'))
        .flatMap(line => {
          const match = line.match(/\-(\d+)(,\d+)?/);
          if (match) {
            const start = parseInt(match[1], 10);
            const count = match[2] ? parseInt(match[2].substring(1), 10) : 1;
            return Array.from({ length: count }, (_, i) => start + i);
          }
          return [];
        });

      const routes = await detectRoutesInFile(file, changedLines);
      console.log('----------1', routes, changedLines, file);
      const commentingLines = getCommentingLines(routes, changedLines);
      console.log('----------2', commentingLines);
      const existingComments = await getExistingComments(context.repo.owner, context.repo.repo, context.payload.pull_request.number, botUsername);

      const baseBranchRoutes = await detectRoutesInFile(file, deletedLines, 'deleted');
      console.log('----------3', baseBranchRoutes, deletedLines, file);
      const commentingLinesDeleted = getCommentingLines(baseBranchRoutes, deletedLines);
      console.log('----------4', commentingLinesDeleted);


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

    // Add 'change-route' label with red color
    await addLabelIfNotExists(context.repo.owner, context.repo.repo, context.payload.pull_request.number, TAG_NAME);
  }
}

main();

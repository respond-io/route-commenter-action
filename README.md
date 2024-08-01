
# Route Commenter Action

This GitHub Action detects changes in route files within a PR and adds comments to the start of modified route blocks.

## Usage

Create a workflow file in your repository (e.g., `.github/workflows/route-commenter.yml`):

```yaml
name: Route Commenter

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches:
      - 'master'

permissions:
  contents: read
  pull-requests: write

jobs:
  comment-routes:
    runs-on: ubuntu-latest

    steps:
    - name: Checkout monorepo
      uses: actions/checkout@v2
      with:
        fetch-depth: 0

    - name: Route Commenter Action
      uses: hasithaishere/route-commenter-action@main
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        INPUT_COMMENT_CONTENT_FILE: '.github/config/route-comment-content.md'
```

Create a route comment content file in your repository (e.g., `.github/config/route-comment-content.md`):

```markdown
<!-- ROUTE_COMMENT_START -->
# Route change detected:
- [ ] Have you checked ACL middlewares configs?
- [ ] Have you checked the route is not breaking any existing functionality?
- [ ] Have you checked the route is not breaking any existing tests?
- [ ] Have you documented the route changes?
<!-- ROUTE_COMMENT_END -->
```
This content file will be optional and the default content will be used if not provided.


## License

MIT

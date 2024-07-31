
# Route Commenter Action

This GitHub Action detects changes in route files within a PR and adds comments to the start of modified route blocks.

## Usage

Create a workflow file in your repository (e.g., `.github/workflows/route-commenter.yml`):

```yaml
name: Route Commenter

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  comment-routes:
    runs-on: ubuntu-latest

    steps:
    - name: Checkout monorepo
      uses: actions/checkout@v2

    - name: Route Commenter Action
      uses: hasithaishere/route-commenter-action@v1
      with:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## License

MIT

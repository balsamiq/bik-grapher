README
======

This is a program implemented quick and dirty to generate dependency graphs for AWS CloudFormation stacks with Balsamiq-sauce.

An example of why this may be useful:

![]()

Above graph shows circular dependencies (🔵 nodes have dependencies, 🟢 have no dependencies, and 🔴 have circular dependencies) when you look at an "app-level." This means, you wouldn't be able to deploy BAS and RTC with all their stacks all at once, as they [circularly] depend on each other.

However, if you look at BAS and RTCs individual stacks in more detail;

![]()

You can see there's a viable deployment path for these two apps:

1. Deploy BAS's config stack
2. Deploy RTC's config stack
3. Now you can deploy the rest of BAS and RTC apps


## Getting going

```
nvm install && nvm use && npm install
```

You must also install [Graphviz](http://www.graphviz.org/):

```
brew install graphviz     # on macOS
apt-get install graphviz  # on Ubuntu
```


## Help

```
nvm use && npm start staging -- --help
```


## About caching

A `cache/` folder will be generated for you for the first time you run this program. This is an optimization when you wan't to send requests to AWS APIs in each run. If you need to fetch fresh data, either because there are changes in live CloudFormation since the last time you fetched'em, or because you want to fetch data from a different AWS account or region, then you should delete this folder before running the program again.


## Usage examples

In the examples below you'll need to specify your own AWS credentials either via `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables, as well as specify the region you want to query via `AWS_REGION`.

This program doesn't clean cache files (`cache/`) or artifacts (`.output/`) it generates on purpose, so in most cases it it recommended you do that instead, as seen in below examples.

For more than one app, this program will generate `graph-apps.png` and `graph-stacks.png` files, whilst for a single app it will generate only the `graph-stacks.png`.

First run, for staging environment, for all apps:

```
rm -rf .cache/ .output/ *.png ; nvm use && AWS_PROFILE=b-everything-else AWS_REGION=eu-west-1 npm start staging
```

Generate dependency graph for BAS & RTC, for staging environment, using existing cache:

```
rm -rf .output/ *.png ; nvm use && AWS_PROFILE=b-everything-else AWS_REGION=eu-west-1 && npm start staging -- --app bas --app rtc
```

Generate dependency graph for Cloud *production* only (NOTE: cleaning cache):

```
rm -rf .cache/ .output/ *.png ; nvm use && AWS_PROFILE=b-production-products AWS_REGION=us-east-1 && npm start production -- --app cloud
```


## Advanced usage examples

Under the hood we're using [Madge](https://www.npmjs.com/package/madge), so once you generated the artifacts (i.e., `.output/`) you can use any other Madge command to generate other types of graphs.

See things that you can do:

```
nvm use && npx madge --help
```

Show circular stack dependencies:

```
nvm use && npx madge --circular .output/stacks/
```

Output apps dependencies as JSON:

```
nvm use && npx madge --circular .output/apps/
```

Use a different format (JPEG) and layout engine for image:

```
nvm use && npx madge --image example.jpg --layout neato .output/apps/
```

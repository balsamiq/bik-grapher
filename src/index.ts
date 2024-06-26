import {
  CloudFormationClient,
  CloudFormationServiceException,
  DescribeStacksCommand,
  Export,
  ListExportsCommand,
  ListImportsCommand,
  Stack,
} from "@aws-sdk/client-cloudformation";
import { program, Option } from "commander";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import madge from "madge";
import { join as joinPath } from "path";

const CACHE_DIR = ".cache";
const OUTPUT_BASEDIR = ".output";
const APP_OUTPUT_DIR = joinPath(OUTPUT_BASEDIR, "apps");
const STACK_OUTPUT_DIR = joinPath(OUTPUT_BASEDIR, "stacks");

class CloudFormation {
  constructor(private cfClient: CloudFormationClient) {}

  describeStacks() {
    return this.consumeAllTokens(DescribeStacksCommand, "Stacks") as Promise<Stack[]>;
  }

  listExports() {
    return this.consumeAllTokens(ListExportsCommand, "Exports") as Promise<Export[]>;
  }

  async listImports(exportName: string) {
    try {
      return (await this.consumeAllTokens(ListImportsCommand, "Imports", { ExportName: exportName })) as string[];
    } catch (error) {
      if (
        error instanceof CloudFormationServiceException &&
        error.message == `Export '${exportName}' is not imported by any stack.`
      ) {
        return [];
      }
      throw error;
    }
  }

  private async consumeAllTokens<T, TCommand extends { new (args: any): any }>(
    Command: TCommand,
    resultProp: string,
    commandArgs?: object,
  ): Promise<T[]> {
    const result: T[] = [];

    let nextToken: string | undefined;
    do {
      let partialResults: T[] | undefined;
      const command = new Command({ ...commandArgs, NextToken: nextToken });
      ({ [resultProp]: partialResults, NextToken: nextToken } = (await this.cfClient.send(command)) as any);
      if (partialResults) {
        result.push(...partialResults);
      }
    } while (nextToken);

    return result;
  }
}

interface Cache {
  cacheOrWork<T>(key: string, work: () => T): Promise<T>;
}

class FilesystemCache implements Cache {
  constructor(private cacheDir: string) {
    mkdir(cacheDir, { recursive: true });
  }

  async cacheOrWork<T>(path: string, work: () => T): Promise<T> {
    const cacheFileName = joinPath(this.cacheDir, path);

    const cacheContents = await FilesystemCache._readFileOrNull(cacheFileName);
    if (cacheContents) {
      return JSON.parse(cacheContents);
    }

    const result = await work();
    writeFile(cacheFileName, JSON.stringify(result, null, 2));
    return result;
  }

  private static async _readFileOrNull(path: Parameters<typeof readFile>["0"]) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "syscall" in error &&
        error.syscall === "open" &&
        "code" in error &&
        error.code == "ENOENT"
      ) {
        return null;
      }

      throw error;
    }
  }
}

const INCLUDE_OPTION_CHOICES = ["mysql", "redis"] as const;
type IncludeOptionChoice = (typeof INCLUDE_OPTION_CHOICES)[number];

async function main() {
  const region = process.env.AWS_REGION;

  let environment = ""; // making typescript happy

  program
    .argument("<environment>")
    .addOption(
      variadicOption(
        "-a, --app <app>",
        "useful to focus on one app's stacks only or to focus on relations between specific apps",
      ),
    )
    .addOption(
      variadicOption(
        `--include <${INCLUDE_OPTION_CHOICES.join("|")}>`,
        "by default some stacks are hidden to reduce verbosity of the output, but with this flag you can include those as well",
      ).choices(INCLUDE_OPTION_CHOICES),
    )
    .action((environmentArg) => {
      environment = environmentArg;
    })
    .parse();

  const {
    app: apps,
    include: includes,
  }: { app?: string[]; include?: IncludeOptionChoice[]; withMysqlAndRedis: boolean } = program.opts();

  // ---------------------------------------------------------------------------

  mkdir(APP_OUTPUT_DIR, { recursive: true });
  mkdir(STACK_OUTPUT_DIR, { recursive: true });

  // ---------------------------------------------------------------------------

  const cache = new FilesystemCache(CACHE_DIR);

  // ---------------------------------------------------------------------------

  await processCloudFormation(cache, { region }, environment, apps, includes);
  if (region !== "us-east-1") {
    await processCloudFormation(cache, { region: "us-east-1", implicit: true }, environment, apps, includes);
  }

  // ---------------------------------------------------------------------------

  if (!apps || apps.length > 1) {
    const graph = await madge(APP_OUTPUT_DIR);
    graph.image(`graph-apps.png`);
  }

  const graph = await madge(STACK_OUTPUT_DIR);
  graph.image(`graph-stacks.png`);
}

function variadicOption(...params: ConstructorParameters<typeof Option>) {
  if (params[1] /* description */) {
    params[1] = `${params[1]} (can be specified multiple times)`;
  }

  const option = new Option(...params);
  option.variadic = true;
  return option;
}

type RegionConfiguration = {
  region?: string;
  implicit?: true;
};

async function processCloudFormation(
  cache: Cache,
  regionConfig: RegionConfiguration,
  environment: string,
  apps?: string[],
  includes?: IncludeOptionChoice[],
) {
  const cloudFormation = new CloudFormation(
    new CloudFormationClient({
      region: regionConfig.region,
      maxAttempts: 10, // I increased this number, because the default (3) was not enough and was causing "Throttling: Rate exceeded" error
    }),
  );

  const stacks = await getStacks(cache, cloudFormation, regionConfig.region);
  const exportsWithImportingStacks = await getExportsWithImportingStacks(
    await cache.cacheOrWork(
      `${regionConfig.region}_exports.cache.json`,
      async () => await cloudFormation.listExports(),
    ),
    cache,
    cloudFormation,
    regionConfig.region,
  );

  const interestingStacks = [...stacks.values()].filter((stack) =>
    isInterestingStack(stack, environment, apps, includes),
  );
  for (const stack of interestingStacks) {
    if (!apps || apps.length > 1) {
      writeFile(joinPath(APP_OUTPUT_DIR, `${getNodeNameForApp(stack, regionConfig)}.js`), "");
    }
    writeFile(joinPath(STACK_OUTPUT_DIR, `${getNodeNameForStack(stack, regionConfig)}.js`), "");
  }

  for (const { export: eexport, imports } of exportsWithImportingStacks) {
    if (!eexport.ExportingStackId) {
      // This should never happen, but just in case:
      throw new Error(`Invalid export '${eexport}'`);
    }

    const exportingStack = stacks.get(eexport.ExportingStackId);
    if (!exportingStack) {
      throw new Error(`Couldn't find stack '${eexport.ExportingStackId}'`);
    }
    if (!isInterestingStack(exportingStack, environment, apps, includes)) {
      continue;
    }

    for (const iimport of imports) {
      const importingStack = stacks.get(iimport);
      if (!importingStack) {
        throw new Error(`Couldn't find stack '${iimport}'`);
      }
      if (!isInterestingStack(importingStack, environment, apps, includes)) {
        continue;
      }

      let exportingNode: string;
      let importingNode: string;

      if (
        (!apps || apps.length > 1) &&
        (exportingNode = getNodeNameForApp(exportingStack, regionConfig)) !=
          (importingNode = getNodeNameForApp(importingStack, regionConfig))
      ) {
        appendFile(
          joinPath(APP_OUTPUT_DIR, `${importingNode}.js`),
          `require('./${exportingNode}'); // ${eexport.Name}\n`,
        );
      }

      if (
        (exportingNode = getNodeNameForStack(exportingStack, regionConfig)) !=
        (importingNode = getNodeNameForStack(importingStack, regionConfig))
      ) {
        appendFile(
          joinPath(STACK_OUTPUT_DIR, `${importingNode}.js`),
          `require('./${exportingNode}'); // ${eexport.Name}\n`,
        );
      }
    }
  }
}

function getNodeNameForApp(stack: Stack, regionConfig: RegionConfiguration) {
  const appName = getTagValue(stack, "balsamiq-product");
  const environment = getTagValue(stack, "environment");
  if (appName && environment) {
    return `${appName}-${environment}${regionConfig.implicit ? ` (${regionConfig.region})` : ""}`;
  } else if (stack.StackName) {
    return `${stack.StackName}${regionConfig.implicit ? ` (${regionConfig.region})` : ""}`;
  }
  throw new Error(`Invalid stack '${stack}'`);
}

function getNodeNameForStack(stack: Stack, regionConfig: RegionConfiguration) {
  if (stack.StackName) {
    return `${stack.StackName}${regionConfig.implicit ? ` (${regionConfig.region})` : ""}`;
  }
  throw new Error(`Invalid stack '${stack}'`);
}

function getTagValue(stack: Stack, key: string) {
  if (!stack.Tags) {
    // This should never happen, but just in case:
    throw new Error(`Invalid stack '${stack}'`);
  }

  const tag = stack.Tags.find((tag) => tag.Key === key);
  if (!tag) {
    return null;
  }

  if (!tag.Value) {
    // This should never happen, but just in case:
    throw new Error(`Invalid tag '${tag}'`);
  }

  return tag.Value;
}

async function getExportsWithImportingStacks(
  exports: Export[],
  cache: Cache,
  cfClient: CloudFormation,
  region?: string,
) {
  const result: { export: Export; imports: string[] }[] = [];
  for (const eexport of exports) {
    result.push({
      export: eexport,
      imports: await cache.cacheOrWork(`${region}_cfListImports-${eexport.Name}`, () => {
        if (!eexport.Name) {
          // This should never happen, but just in case:
          throw new Error(`Invalid export '${eexport}'`);
        }
        return cfClient.listImports(eexport.Name);
      }),
    });
  }

  return result;
}

function isInterestingStack(stack: Stack, environment: string, apps?: string[], includes?: IncludeOptionChoice[]) {
  if (!stack.StackName) {
    // This should never happen, but just in case:
    throw new Error(`Invalid stack '${stack}'`);
  }

  let result = true;

  // Checks that are safe to apply always:
  result =
    result &&
    /* Exclude CDK toolkit stack */ !/^CDKToolkit$/.test(stack.StackName) &&
    /* Exclude nested stacks */ !("ParentId" in stack) &&
    /* Exclude shared infra stacks */ !/^internal-/.test(stack.StackName) &&
    /* Exclude some singleton stacks (i.e., cross-app&env) */ !/^(balsamiq-slack)$/.test(stack.StackName) &&
    /* Exclude some apps */ !/^(workflow-triggerer|autosavedreactionsforslack|acetaia|bottega)-/.test(stack.StackName);

  if (!includes || !includes.includes("mysql")) {
    result = result && /* Exclude mysql resource-stack */ !/-mysql$/.test(stack.StackName);
  }
  if (!includes || !includes.includes("redis")) {
    result = result && /* Exclude redis resource-stack */ !/-redis$/.test(stack.StackName);
  }

  return (
    result &&
    new RegExp(`-${environment}-|-${environment}$`).test(stack.StackName) &&
    (!apps || new RegExp(`^(${apps.join("|")})-`).test(stack.StackName))
  );
}

async function getStacks(cache: Cache, cfClient: CloudFormation, region?: string) {
  const stacks = await cache.cacheOrWork(`${region}_stacks.cache.json`, async () => await cfClient.describeStacks());

  const result = stacks.reduce((result, stack) => {
    if (!stack.StackId || !stack.StackName) {
      // This should never happen, but just in case:
      throw new Error(`Invalid stack '${stack}'`);
    }
    result.set(stack.StackId, stack);
    result.set(stack.StackName, stack);

    return result;
  }, new Map<string, Stack>());

  return result;
}

main();

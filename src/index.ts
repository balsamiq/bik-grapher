import {
  CloudFormationClient,
  CloudFormationServiceException,
  DescribeStacksCommand,
  Export,
  ListExportsCommand,
  ListImportsCommand,
  Stack,
} from "@aws-sdk/client-cloudformation";
import { program } from "commander";
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

async function main() {
  let environment = ""; // making typescript happy

  program
    .argument("<environment>")
    .option(
      "-a, --app <app...>",
      "useful to focus on one app's stacks only or to focus on relations between specific apps (can be specified multiple times)",
    )
    .action((environmentArg) => {
      environment = environmentArg;
    })
    .parse();

  const { app: apps }: { app?: string[] } = program.opts();

  mkdir(APP_OUTPUT_DIR, { recursive: true });
  mkdir(STACK_OUTPUT_DIR, { recursive: true });

  const cache = new FilesystemCache(CACHE_DIR);
  const cloudFormation = new CloudFormation(
    new CloudFormationClient({
      maxAttempts: 10, // I increased this number, because the default (3) was not enough and was causing "Throttling: Rate exceeded" error
    }),
  );

  const stacks = await getStacks(cache, cloudFormation);
  const exportsWithImportingStacks = await getExportsWithImportingStacks(
    await cache.cacheOrWork("exports.cache.json", async () => await cloudFormation.listExports()),
    cache,
    cloudFormation,
  );

  const interestingStacks = [...stacks.values()].filter((stack) => isInterestingStack(stack, environment, apps));
  for (const stack of interestingStacks) {
    if (!apps || apps.length > 1) {
      writeFile(joinPath(APP_OUTPUT_DIR, `${getNodeNameForApp(stack)}.js`), "");
    }
    writeFile(joinPath(STACK_OUTPUT_DIR, `${getNodeNameForStack(stack)}.js`), "");
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
    if (!isInterestingStack(exportingStack, environment, apps)) {
      continue;
    }

    for (const iimport of imports) {
      const importingStack = stacks.get(iimport);
      if (!importingStack) {
        throw new Error(`Couldn't find stack '${iimport}'`);
      }
      if (!isInterestingStack(importingStack, environment, apps)) {
        continue;
      }

      let exportingNode: string;
      let importingNode: string;

      if (
        (!apps || apps.length > 1) &&
        (exportingNode = getNodeNameForApp(exportingStack)) != (importingNode = getNodeNameForApp(importingStack))
      ) {
        appendFile(
          joinPath(APP_OUTPUT_DIR, `${importingNode}.js`),
          `require('./${exportingNode}'); // ${eexport.Name}\n`,
        );
      }

      if (
        (exportingNode = getNodeNameForStack(exportingStack)) != (importingNode = getNodeNameForStack(importingStack))
      ) {
        appendFile(
          joinPath(STACK_OUTPUT_DIR, `${importingNode}.js`),
          `require('./${exportingNode}'); // ${eexport.Name}\n`,
        );
      }
    }
  }

  if (!apps || apps.length > 1) {
    const graph = await madge(APP_OUTPUT_DIR);
    graph.image(`graph-apps.png`);
  }

  const graph = await madge(STACK_OUTPUT_DIR);
  graph.image(`graph-stacks.png`);
}

function getNodeNameForApp(stack: Stack) {
  const appName = getTagValue(stack, "balsamiq-product");
  const environment = getTagValue(stack, "environment");
  if (appName && environment) {
    return `${appName}-${environment}`;
  } else if (stack.StackName) {
    return stack.StackName;
  }
  throw new Error(`Invalid stack '${stack}'`);
}

function getNodeNameForStack(stack: Stack) {
  if (stack.StackName) {
    return stack.StackName;
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

async function getExportsWithImportingStacks(exports: Export[], cache: Cache, cfClient: CloudFormation) {
  const result: { export: Export; imports: string[] }[] = [];
  for (const eexport of exports) {
    result.push({
      export: eexport,
      imports: await cache.cacheOrWork(`cfListImports-${eexport.Name}`, () => {
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

function isInterestingStack(stack: Stack, environment: string, apps?: string[]) {
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

  // Checks that we may want to not apply in the future:
  result = result && /* Exclude some resource-stacks */ !/-(mysql|redis)$/.test(stack.StackName);

  return (
    result &&
    new RegExp(`-${environment}-|-${environment}$`).test(stack.StackName) &&
    (!apps || new RegExp(`^(${apps.join("|")})-`).test(stack.StackName))
  );
}

async function getStacks(cache: Cache, cfClient: CloudFormation) {
  const stacks = await cache.cacheOrWork("stacks.cache.json", async () => await cfClient.describeStacks());

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

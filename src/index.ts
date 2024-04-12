import {
  CloudFormationClient,
  CloudFormationServiceException,
  DescribeStacksCommand,
  DescribeStacksCommandOutput,
  Export,
  ListExportsCommand,
  ListExportsCommandOutput,
  ListImportsCommand,
  ListImportsCommandOutput,
  Stack,
} from "@aws-sdk/client-cloudformation";
import { program } from "commander";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import madge from "madge";
import * as path from "path";

const CACHE_DIR = ".cache";
const OUTPUT_BASEDIR = ".output";
const APP_OUTPUT_DIR = path.join(OUTPUT_BASEDIR, "apps");
const STACK_OUTPUT_DIR = path.join(OUTPUT_BASEDIR, "stacks");

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

  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(APP_OUTPUT_DIR, { recursive: true });
  await mkdir(STACK_OUTPUT_DIR, { recursive: true });

  const cfClient = new CloudFormationClient({
    maxAttempts: 10, // I increased this number, because the default (3) was not enough and was causing "Throttling: Rate exceeded" error
  });

  const stacks = await getStacks(cfClient);
  const exportsWithImportingStacks = await getExportsWithImportingStacks(await cfListExports(cfClient), cfClient);

  for (const stack of [...stacks.values()].filter((stack) => isInterestingStack(stack, environment, apps))) {
    if (!apps || apps.length > 1) {
      writeFile(path.join(APP_OUTPUT_DIR, `${getNodeNameForApp(stack)}.js`), "");
    }
    writeFile(path.join(STACK_OUTPUT_DIR, `${getNodeNameForStack(stack)}.js`), "");
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
          path.join(APP_OUTPUT_DIR, `${importingNode}.js`),
          `require('./${exportingNode}'); // ${eexport.Name}\n`,
        );
      }

      if (
        (exportingNode = getNodeNameForStack(exportingStack)) != (importingNode = getNodeNameForStack(importingStack))
      ) {
        appendFile(
          path.join(STACK_OUTPUT_DIR, `${importingNode}.js`),
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

main();

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

async function getExportsWithImportingStacks(exports: Export[], cfClient: CloudFormationClient) {
  const result: { export: Export; imports: string[] }[] = [];
  for (const eexport of exports) {
    if (!eexport.Name) {
      // This should never happen, but just in case:
      throw new Error(`Invalid export '${eexport}'`);
    }

    result.push({
      export: eexport,
      imports: await cfListImports(eexport.Name, cfClient),
    });
  }

  return result;
}

async function cfListImports(exportName: string, cfClient: CloudFormationClient) {
  const cacheFileName = path.join(CACHE_DIR, `imports-${exportName}.cache.json`);

  let allImports: string[] | null;
  if ((allImports = await parseJSONFileOrNull(cacheFileName))) {
    return allImports;
  }

  allImports = [];

  let nextToken: ListImportsCommandOutput["NextToken"];
  do {
    let imports: ListImportsCommandOutput["Imports"];
    const command = new ListImportsCommand({
      ExportName: exportName,
      NextToken: nextToken,
    });
    try {
      ({ Imports: imports, NextToken: nextToken } = await cfClient.send(command));
    } catch (error) {
      if (
        error instanceof CloudFormationServiceException &&
        error.message == `Export '${exportName}' is not imported by any stack.`
      ) {
        return [];
      }

      throw error;
    }

    if (imports) {
      allImports.push(...imports);
    }
  } while (nextToken);

  writeFile(cacheFileName, JSON.stringify(allImports, null, 2));
  return allImports;
}

async function cfListExports(cfClient: CloudFormationClient) {
  const cacheFile = path.join(CACHE_DIR, "exports.cache.json");

  let allExports: Export[] | null;
  if ((allExports = await parseJSONFileOrNull(cacheFile))) {
    return allExports;
  }

  allExports = [];

  let nextToken: ListExportsCommandOutput["NextToken"];
  do {
    let exports: ListExportsCommandOutput["Exports"];
    const command = new ListExportsCommand({ NextToken: nextToken });
    ({ Exports: exports, NextToken: nextToken } = await cfClient.send(command));
    if (exports) {
      allExports.push(...exports);
    }
  } while (nextToken);

  writeFile(cacheFile, JSON.stringify(allExports, null, 2));
  return allExports;
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

async function getStacks(cfClient: CloudFormationClient) {
  const stacks = await cfDescribeStacks(cfClient);

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

async function cfDescribeStacks(cfClient: CloudFormationClient) {
  const cacheFile = path.join(CACHE_DIR, "stacks.cache.json");

  let allStacks: Stack[] | null;
  if ((allStacks = await parseJSONFileOrNull(cacheFile))) {
    return allStacks;
  }

  allStacks = [];

  let nextToken: DescribeStacksCommandOutput["NextToken"];
  do {
    let stacks: DescribeStacksCommandOutput["Stacks"];
    const command = new DescribeStacksCommand({ NextToken: nextToken });
    ({ Stacks: stacks, NextToken: nextToken } = await cfClient.send(command));
    if (stacks) {
      allStacks.push(...stacks);
    }
  } while (nextToken);

  writeFile(cacheFile, JSON.stringify(allStacks, null, 2));
  return allStacks;
}

async function parseJSONFileOrNull<T>(path: Parameters<typeof readFile>["0"]): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
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

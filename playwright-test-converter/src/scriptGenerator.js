import { promises as fs } from "fs";
import { join, relative } from "path";
import { createHash } from "crypto";
import { sanitizeFileName, replaceVariables } from "./utils.js";

let variables = {};
let itemCounter = 0;
let convertedScripts = new Map();
let prerequest_variables = {};

async function createPackageJson(outputDir) {
  if (!outputDir) {
    console.error("Output directory is undefined");
    return;
  }

  const packageJsonContent = {
    name: "playwright-tests",
    version: "1.0.0",
    scripts: {
      test: "playwright test"
    },
    dependencies: {
      "@playwright/test": "^1.0.0"
    }
  };

  const packageJsonPath = join(outputDir, "package.json");
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJsonContent, null, 2), "utf8");
}

async function loadVariables(outputDir) {
  if (!outputDir) {
    console.error("Output directory is undefined");
    return;
  }
  const variablesFilePath = join(outputDir, "variables.json");
  try {
    const data = await fs.readFile(variablesFilePath, "utf8");
    variables = JSON.parse(data);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Error loading variables:", error);
    }
  }
}

async function saveVariables(outputDir) {
  if (!outputDir) {
    console.error("Output directory is undefined");
    return;
  }
  const variablesFilePath = join(outputDir, "variables.json");
  await fs.writeFile(
    variablesFilePath,
    JSON.stringify(variables, null, 2),
    "utf8"
  );
}

function replacePathParams(url, params) {
  const paramsMap = params.reduce((acc, param) => {
    acc[param.key] = param.value;
    return acc;
  }, {});

  return url.replace(/:(\w+)/g, (_, key) => {
    if (key in paramsMap) {
      return paramsMap[key];
    }
    throw new Error(`Missing value for path parameter: ${key}`);
  });
}

function replaceQueryParams(url, query) {
  const queryMap = query.reduce((acc, param) => {
    acc[param.key] = param.value;
    return acc;
  }, {});

  if (!prerequest_variables || Object.keys(prerequest_variables).length === 0)
    return url;

  return url.replace(
    /([?&])([^&=]+)=({{(.*?)}})/g,
    (match, delimiter, key, placeholder, paramName) => {
      return `${delimiter}${key}=${
        prerequest_variables[paramName] || placeholder
      }`;
    }
  );
}

function convertPreRequestScript(script) {
  if (!script) return "";

  let convertedScript = "  // Pre-request Script\n";
  const lines = script.split("\n");
  const regex = /(?<=\.set\(")([^"]+)",\s*([^)]*)\)/g;
  lines.forEach((line) => {
    if (
      line.includes("pm.variables.set") ||
      line.includes("pm.collectionVariables.set") ||
      line.includes("pm.environment.set") ||
      line.includes("pm.globals.set")
    ) {
      let match;
      if ((match = regex.exec(line)) !== null) {
        const key = match[1];
        const value = match[2]?.trim()?.replace(/"/g, "");

        const formattedValue = isNaN(value) ? value : Number(value);
        prerequest_variables[key] = formattedValue;
      }
    } else {
      convertedScript += `  ${line}\n`;
    }
  });
  convertedScript += `  const prerequest_variables = ${JSON.stringify(
    prerequest_variables,
    null,
    2
  )}\n`;
  return convertedScript;
}

function convertPostResponseScript(script) {
  if (!script) return "";

  const scriptHash = createHash("md5").update(script).digest("hex");
  if (convertedScripts.has(scriptHash)) {
    return convertedScripts.get(scriptHash);
  }

  let convertedScript = "// Post-response Script (Tests)\n";
  const lines = script.split("\n");
  let insideTest = false;
  let currentTestName = "";

  const assertionRegex =
    /pm\.expect\((.*?)\)\.to\.(be\.an?|have)(\.property)?\(['"](\w+)['"]\)/;
  const arrayAssertionRegex =
    /pm\.expect\((.*?)\)\.to\.be\.an\(['"]array['"]\)/;
  const startRegex = /pm\.expect\((.*?)\)/;
  const variableNameRegex = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

  lines.forEach((line) => {
    if (line.includes("pm.test(")) {
      insideTest = true;
      const match = line.match(/pm\.test\("(.+?)"/);
      if (match) {
        currentTestName = match[1];
        convertedScript += `\n  // ${currentTestName}\n`;
      }
    } else if (insideTest && line.includes("});")) {
      insideTest = false;
    } else if (insideTest) {
      if (line.includes("pm.response.to.have.status")) {
        convertedScript += `    expect(response.status()).toBe(${
          line.match(/\d+/)[0]
        });\n`;
      } else if (
        line.includes("pm.expect(pm.response.responseTime).to.be.below")
      ) {
        convertedScript += `    expect(responseTime).toBeLessThan(${
          line.match(/\d+/)[0]
        });\n`;
      } else if (line.includes("pm.expect")) {
        const playwrightAssert = line
          .replace("pm.expect", "expect")
          .replace("response", "pwResponse")
          .replace(".to.equal(", ".toBe(")
          .replace(".to.have.property(", "data.")
          .replace(".to.include(", ".toContain(");
        convertedScript += `${playwrightAssert}\n`;
      }
    }
  });

  convertedScripts.set(scriptHash, convertedScript);
  return convertedScript;
}

export function generatePlaywrightTest(item, folderPath, outputDir) {
  const { name, request, event } = item;
  const { method, url, header, body } = request;

  let preRequestScript = "";
  let postResponseScript = "";

  if (event) {
    const preRequestEvent = event.find((e) => e.listen === "prerequest");
    const testEvent = event.find((e) => e.listen === "test");

    if (preRequestEvent && preRequestEvent.script) {
      preRequestScript = convertPreRequestScript(
        preRequestEvent.script.exec.join("\n")
      );
    }

    if (testEvent && testEvent.script) {
      postResponseScript = convertPostResponseScript(
        testEvent.script.exec.join("\n")
      );
    }
  }

  let requestOptions = {};
  if (header && header.length > 0) {
    requestOptions.headers = header.reduce(
      (acc, h) => ({ ...acc, [h.key]: replaceVariables(h.value, variables) }),
      {}
    );
  }
  if (body && body.mode === "raw") {
    try {
      requestOptions.data = JSON.parse(replaceVariables(body.raw, variables));
    } catch {
      requestOptions.data = replaceVariables(body.raw, variables);
    }
  }

  let requestUrl = url?.raw
    ? replaceVariables(url.raw, variables)
    : "undefined_url";
  requestUrl =
    url?.variable?.length > 0
      ? replacePathParams(requestUrl, url.variable)
      : requestUrl;
  requestUrl =
    url?.query?.length > 0
      ? replaceQueryParams(requestUrl, url.query)
      : requestUrl;

  const relativePath = relative(folderPath, outputDir).replace(/\\/g, "/");
  const variablesImport = relativePath
    ? `import { variables } from '${relativePath}/variables.js';`
    : `import { variables } from './variables.js';`;

  return `
import { test, expect } from '@playwright/test';
${variablesImport}

test('${name}', async ({ request }) => {
${preRequestScript}
  const startTime = Date.now();

  const response = await request.${method.toLowerCase()}('${requestUrl}'${
    Object.keys(requestOptions).length > 0
      ? `, ${JSON.stringify(requestOptions, null, 2)}`
      : ""
  });
  const responseTime = Date.now() - startTime;
  const pwResponse = await response.json();
  ${postResponseScript}
});
`;
}

async function processItem(item, parentPath = "", outputDir) {
  if (!outputDir) {
    console.error("Output directory is undefined");
    return;
  }
  const itemNumber = String(itemCounter++).padStart(3, "0");

  if (item.item) {
    // This is a folder
    const folderPath = join(
      parentPath,
      `${itemNumber}_${sanitizeFileName(item.name)}`
    );
    await fs.mkdir(folderPath, { recursive: true });

    for (const subItem of item.item) {
      await processItem(subItem, folderPath, outputDir);
    }
  } else if (item.request) {
    // This is a request
    const testScript = generatePlaywrightTest(item, parentPath, outputDir);
    const fileName = `${itemNumber}_${sanitizeFileName(item.name)}.spec.js`;
    const filePath = join(parentPath, fileName);
    await fs.writeFile(filePath, testScript);
  }
}

export async function processCollection(collection, outputDir) {
  if (!outputDir) {
    throw new Error("Output directory is undefined");
  }
  console.log(`Processing collection. Output directory: ${outputDir}`);

  await loadVariables(outputDir);

  if (collection.variable) {
    collection.variable.forEach((v) => {
      variables[v.key] = v.value;
    });
  }

  itemCounter = 0;
  convertedScripts.clear(); // Clear the converted scripts before processing a new collection
  for (const item of collection.item) {
    await processItem(item, outputDir, outputDir);
  }

  await saveVariables(outputDir);

  // Create a variables.js file to export the variables
  const variablesJsContent = `export const variables = ${JSON.stringify(
    variables,
    null,
    2
  )};`;
  const variablesJsPath = join(outputDir, "variables.js");
  await fs.writeFile(variablesJsPath, variablesJsContent);

  await createPackageJson(outputDir);
}

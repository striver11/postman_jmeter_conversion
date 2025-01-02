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

  console.log(JSON.stringify(event, null, 2))

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

  return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="api.restful-api.dev">
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables">
        <collectionProp name="Arguments.arguments">
          <elementProp name="PROTOCOL" elementType="Argument">
            <stringProp name="Argument.name">PROTOCOL</stringProp>
            <stringProp name="Argument.value">https</stringProp>
            <stringProp name="Argument.metadata">=</stringProp>
          </elementProp>
          <elementProp name="URL" elementType="Argument">
            <stringProp name="Argument.name">URL</stringProp>
            <stringProp name="Argument.value">api.restful-api.dev</stringProp>
            <stringProp name="Argument.metadata">=</stringProp>
          </elementProp>
        </collectionProp>
      </elementProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Thread Group">
        <intProp name="ThreadGroup.num_threads">1</intProp>
        <intProp name="ThreadGroup.ramp_time">1</intProp>
        <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller">
          <stringProp name="LoopController.loops">1</stringProp>
          <boolProp name="LoopController.continue_forever">false</boolProp>
        </elementProp>
      </ThreadGroup>
      <hashTree>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="GetAPI">
          <stringProp name="HTTPSampler.domain">\${URL}</stringProp>
          <stringProp name="HTTPSampler.protocol">\${PROTOCOL}</stringProp>
          <stringProp name="HTTPSampler.path">/objects</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
          <boolProp name="HTTPSampler.postBodyRaw">false</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>
        </HTTPSamplerProxy>
        <hashTree>
          <JSONPathAssertion guiclass="JSONPathAssertionGui" testclass="JSONPathAssertion" testname="Assert Id 1 is present">
            <stringProp name="JSON_PATH">$[0].id</stringProp>
            <stringProp name="EXPECTED_VALUE">1</stringProp>
            <boolProp name="JSONVALIDATION">true</boolProp>
            <boolProp name="EXPECT_NULL">false</boolProp>
            <boolProp name="INVERT">false</boolProp>
            <boolProp name="ISREGEX">true</boolProp>
          </JSONPathAssertion>
          <hashTree/>
          <JSONPathAssertion guiclass="JSONPathAssertionGui" testclass="JSONPathAssertion" testname="Assert name is Google Pixel 6 Pro">
            <stringProp name="JSON_PATH">$[0].name</stringProp>
            <stringProp name="EXPECTED_VALUE">Google Pixel 6 Pro</stringProp>
            <boolProp name="JSONVALIDATION">true</boolProp>
            <boolProp name="EXPECT_NULL">false</boolProp>
            <boolProp name="INVERT">false</boolProp>
            <boolProp name="ISREGEX">true</boolProp>
          </JSONPathAssertion>
          <hashTree/>
          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Response Assertion">
            <collectionProp name="Asserion.test_strings">
              <stringProp name="49586">200</stringProp>
            </collectionProp>
            <stringProp name="Assertion.custom_message"></stringProp>
            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
            <boolProp name="Assertion.assume_success">false</boolProp>
            <intProp name="Assertion.test_type">8</intProp>
          </ResponseAssertion>
          <hashTree/>
          <ResultCollector guiclass="AssertionVisualizer" testclass="ResultCollector" testname="Assertion Results">
            <boolProp name="ResultCollector.error_logging">true</boolProp>
            <objProp>
              <name>saveConfig</name>
              <value class="SampleSaveConfiguration">
                <time>true</time>
                <latency>true</latency>
                <timestamp>true</timestamp>
                <success>true</success>
                <label>true</label>
                <code>true</code>
                <message>true</message>
                <threadName>true</threadName>
                <dataType>true</dataType>
                <encoding>false</encoding>
                <assertions>true</assertions>
                <subresults>true</subresults>
                <responseData>false</responseData>
                <samplerData>false</samplerData>
                <xml>false</xml>
                <fieldNames>true</fieldNames>
                <responseHeaders>false</responseHeaders>
                <requestHeaders>false</requestHeaders>
                <responseDataOnError>false</responseDataOnError>
                <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>
                <assertionsResultsToSave>0</assertionsResultsToSave>
                <bytes>true</bytes>
                <sentBytes>true</sentBytes>
                <url>true</url>
                <threadCounts>true</threadCounts>
                <idleTime>true</idleTime>
                <connectTime>true</connectTime>
              </value>
            </objProp>
            <stringProp name="filename"></stringProp>
          </ResultCollector>
          <hashTree/>
        </hashTree>
        <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="Content-Type For Post Requests">
          <collectionProp name="HeaderManager.headers">
            <elementProp name="" elementType="Header">
              <stringProp name="Header.name">Content-Type</stringProp>
              <stringProp name="Header.value">application/json</stringProp>
            </elementProp>
          </collectionProp>
        </HeaderManager>
        <hashTree/>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Post API">
          <stringProp name="HTTPSampler.domain">\${URL}</stringProp>
          <stringProp name="HTTPSampler.protocol">\${PROTOCOL}</stringProp>
          <stringProp name="HTTPSampler.path">/objects</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <stringProp name="HTTPSampler.method">POST</stringProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
          <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">
              <elementProp name="" elementType="HTTPArgument">
                <boolProp name="HTTPArgument.always_encode">false</boolProp>
                <stringProp name="Argument.value">{&#xd;
   &quot;name&quot;: &quot;Apple MacBook Pro 16&quot;,&#xd;
   &quot;data&quot;: {&#xd;
      &quot;year&quot;: 2019,&#xd;
      &quot;price&quot;: 1849.99,&#xd;
      &quot;CPU model&quot;: &quot;Intel Core i9&quot;,&#xd;
      &quot;Hard disk size&quot;: &quot;1 TB&quot;&#xd;
   }&#xd;
}</stringProp>
                <stringProp name="Argument.metadata">=</stringProp>
              </elementProp>
            </collectionProp>
          </elementProp>
        </HTTPSamplerProxy>
        <hashTree>
          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Response Assertion">
            <collectionProp name="Asserion.test_strings">
              <stringProp name="49586">200</stringProp>
            </collectionProp>
            <stringProp name="Assertion.custom_message"></stringProp>
            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
            <boolProp name="Assertion.assume_success">false</boolProp>
            <intProp name="Assertion.test_type">8</intProp>
          </ResponseAssertion>
          <hashTree/>
          <JSONPathAssertion guiclass="JSONPathAssertionGui" testclass="JSONPathAssertion" testname="Assert id is returned">
            <stringProp name="JSON_PATH">$.id</stringProp>
            <stringProp name="EXPECTED_VALUE"></stringProp>
            <boolProp name="JSONVALIDATION">false</boolProp>
            <boolProp name="EXPECT_NULL">false</boolProp>
            <boolProp name="INVERT">false</boolProp>
            <boolProp name="ISREGEX">true</boolProp>
          </JSONPathAssertion>
          <hashTree/>
        </hashTree>
        <ResultCollector guiclass="ViewResultsFullVisualizer" testclass="ResultCollector" testname="View Results Tree">
          <boolProp name="ResultCollector.error_logging">false</boolProp>
          <objProp>
            <name>saveConfig</name>
            <value class="SampleSaveConfiguration">
              <time>true</time>
              <latency>true</latency>
              <timestamp>true</timestamp>
              <success>true</success>
              <label>true</label>
              <code>true</code>
              <message>true</message>
              <threadName>true</threadName>
              <dataType>true</dataType>
              <encoding>false</encoding>
              <assertions>true</assertions>
              <subresults>true</subresults>
              <responseData>false</responseData>
              <samplerData>false</samplerData>
              <xml>false</xml>
              <fieldNames>true</fieldNames>
              <responseHeaders>false</responseHeaders>
              <requestHeaders>false</requestHeaders>
              <responseDataOnError>false</responseDataOnError>
              <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>
              <assertionsResultsToSave>0</assertionsResultsToSave>
              <bytes>true</bytes>
              <sentBytes>true</sentBytes>
              <url>true</url>
              <threadCounts>true</threadCounts>
              <idleTime>true</idleTime>
              <connectTime>true</connectTime>
            </value>
          </objProp>
          <stringProp name="filename"></stringProp>
        </ResultCollector>
        <hashTree/>
        <ResultCollector guiclass="TableVisualizer" testclass="ResultCollector" testname="View Results in Table">
          <boolProp name="ResultCollector.error_logging">false</boolProp>
          <objProp>
            <name>saveConfig</name>
            <value class="SampleSaveConfiguration">
              <time>true</time>
              <latency>true</latency>
              <timestamp>true</timestamp>
              <success>true</success>
              <label>true</label>
              <code>true</code>
              <message>true</message>
              <threadName>true</threadName>
              <dataType>true</dataType>
              <encoding>false</encoding>
              <assertions>true</assertions>
              <subresults>true</subresults>
              <responseData>false</responseData>
              <samplerData>false</samplerData>
              <xml>false</xml>
              <fieldNames>true</fieldNames>
              <responseHeaders>false</responseHeaders>
              <requestHeaders>false</requestHeaders>
              <responseDataOnError>false</responseDataOnError>
              <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>
              <assertionsResultsToSave>0</assertionsResultsToSave>
              <bytes>true</bytes>
              <sentBytes>true</sentBytes>
              <url>true</url>
              <threadCounts>true</threadCounts>
              <idleTime>true</idleTime>
              <connectTime>true</connectTime>
            </value>
          </objProp>
          <stringProp name="filename"></stringProp>
        </ResultCollector>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
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
    const fileName = `${itemNumber}_${sanitizeFileName(item.name)}.jmx`;
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

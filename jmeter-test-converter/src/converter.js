import { promises as fs } from "fs";
import { processCollection } from "./scriptGenerator.js";
const { readFile, mkdir } = fs;

async function convertPostmanToPlaywright(
  postmanCollectionPath,
  outputDir = process.cwd()
) {
  try {
    const postmanCollection = JSON.parse(
      await readFile(postmanCollectionPath, "utf-8")
    );

    await mkdir(outputDir, { recursive: true });

    await processCollection(postmanCollection, outputDir);

    console.log("Conversion complete. Playwright scripts have been generated.");
  } catch (error) {
    console.error("Error converting Postman collection:", error.message);
    process.exit(1);
  }
}

export default convertPostmanToPlaywright;

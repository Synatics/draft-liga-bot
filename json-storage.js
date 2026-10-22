const fs = require("node:fs");
const { dirname } = require("node:path");
const { randomUUID } = require("node:crypto");

/**
 * Replace one JSON document using an exclusively created file in the same directory.
 * The target is untouched until rename succeeds. Only our own temporary file is removed.
 * Errors keep their system codes; failed cleanup is attached alongside the original cause.
 * @param {string} filePath
 * @param {object} document
 * @returns {void}
 */
function writeJsonAtomic(filePath, document) {
  const contents = JSON.stringify(document, null, 2) + "\n";
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor;
  let owned = false;
  try {
    fs.mkdirSync(dirname(filePath), { recursive: true });
    descriptor = fs.openSync(temporaryPath, "wx");
    owned = true;
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    const errors = [error];
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (closeError) { errors.push(closeError); }
    }
    if (owned) {
      try { fs.unlinkSync(temporaryPath); } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") errors.push(cleanupError);
      }
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "JSON-Speicherung und Bereinigung sind fehlgeschlagen.", { cause: error });
    }
    throw error;
  }
}

module.exports = { writeJsonAtomic };

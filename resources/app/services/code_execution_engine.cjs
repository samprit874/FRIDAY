const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID: uuidv4 } = require('crypto');

const TEMP_DIR = os.tmpdir();

function runTerminalCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
        const timeoutMs = options.timeoutMs || 60000;
        const cwd = options.cwd || process.cwd();

        // Safe mode checks
        const dangerousCommands = ['rm -rf /', 'format', 'mkfs', '> /dev/sda'];
        if (dangerousCommands.some(cmd => command.includes(cmd))) {
            return reject(new Error("Command blocked by security policy."));
        }

        const child = exec(command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
            if (error && error.killed) {
                return resolve({ success: false, error: 'Command timed out', stdout, stderr, exitCode: 124 });
            }
            if (error) {
                return resolve({ success: false, error: error.message, stdout, stderr, exitCode: error.code || 1 });
            }
            resolve({ success: true, stdout, stderr, exitCode: 0 });
        });
    });
}

async function runCode(language, code, args = {}, timeoutMs = 60000) {
    const langId = language.toLowerCase();
    const fileId = uuidv4();
    let filePath;
    let command;

    try {
        if (langId === 'python' || langId === 'py') {
            filePath = path.join(TEMP_DIR, `friday_script_${fileId}.py`);
            
            // Create a wrapper script to pass arguments if needed, or pass via env
            let envCode = "";
            for (const [k, v] of Object.entries(args)) {
                envCode += `import os\nos.environ["${k}"] = """${v}"""\n`;
            }
            fs.writeFileSync(filePath, envCode + code, 'utf8');
            command = `python "${filePath}"`;
        } 
        else if (langId === 'javascript' || langId === 'nodejs' || langId === 'js' || langId === 'node') {
            filePath = path.join(TEMP_DIR, `friday_script_${fileId}.js`);
            let envCode = "";
            for (const [k, v] of Object.entries(args)) {
                envCode += `process.env["${k}"] = \`${v.replace(/`/g, '\\`')}\`;\n`;
            }
            fs.writeFileSync(filePath, envCode + code, 'utf8');
            command = `node "${filePath}"`;
        }
        else if (langId === 'powershell' || langId === 'ps1') {
            filePath = path.join(TEMP_DIR, `friday_script_${fileId}.ps1`);
            let envCode = "";
            for (const [k, v] of Object.entries(args)) {
                envCode += `$env:${k} = @"\n${v}\n"@\n`;
            }
            fs.writeFileSync(filePath, envCode + code, 'utf8');
            command = `powershell -ExecutionPolicy Bypass -File "${filePath}"`;
        }
        else if (langId === 'bash' || langId === 'sh') {
            filePath = path.join(TEMP_DIR, `friday_script_${fileId}.sh`);
            let envCode = "";
            for (const [k, v] of Object.entries(args)) {
                envCode += `export ${k}="${v.replace(/"/g, '\\"')}"\n`;
            }
            fs.writeFileSync(filePath, envCode + code, 'utf8');
            command = `bash "${filePath}"`;
        }
        else {
            throw new Error(`Unsupported language: ${language}`);
        }

        const result = await runTerminalCommand(command, { timeoutMs });
        return result;

    } catch (e) {
        return { success: false, error: e.message };
    } finally {
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
    }
}

module.exports = {
    runTerminalCommand,
    runCode
};

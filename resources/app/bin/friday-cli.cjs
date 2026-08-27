#!/usr/bin/env node
const readline = require('readline');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

function getAllGeminiKeys() {
    const secretsPath = path.join(__dirname, '..', 'secrets.json');
    const keys = [];
    if (fs.existsSync(secretsPath)) {
        try {
            const sec = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
            if (sec.geminiApiKey) keys.push(sec.geminiApiKey);
            if (sec.geminiApiKey2) keys.push(sec.geminiApiKey2);
            if (sec.geminiImageApiKey) keys.push(sec.geminiImageApiKey);
            if (sec.geminiApiKeys && Array.isArray(sec.geminiApiKeys)) {
                for (const k of sec.geminiApiKeys) { if (k && !keys.includes(k)) keys.push(k); }
            }
        } catch (e) {}
    }
    if (process.env.GEMINI_API_KEY && !keys.includes(process.env.GEMINI_API_KEY)) {
        keys.push(process.env.GEMINI_API_KEY);
    }
    return keys;
}

const allKeys = getAllGeminiKeys();
if (allKeys.length === 0) {
    console.error("Error: No Gemini API keys found in secrets.json or environment.");
    process.exit(1);
}

function loadMemories() {
    let memoriesPath = process.env.APPDATA ? path.join(process.env.APPDATA, 'FRIDAY', 'memories.json') : '';
    let memories = [];
    if (!memoriesPath || !fs.existsSync(memoriesPath)) {
        memoriesPath = path.join(__dirname, '..', '..', '..', 'data', 'memories', 'memories.json');
    }
    if (fs.existsSync(memoriesPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(memoriesPath, 'utf8'));
            if (Array.isArray(parsed)) memories = parsed;
        } catch (e) {}
    }
    return memories.map(m => m.text).join('\n');
}

const memoryContext = loadMemories();
const CANDIDATE_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
let currentKeyIndex = 0;

async function askFriday(prompt) {
    const sysInstruction = `You are FRIDAY, the CLI version of the desktop AI assistant. You act as a highly intelligent, efficient, and slightly sarcastic AI companion, similar to Tony Stark's FRIDAY. You always address the user as 'Sam' or 'Boss'. You provide concise, direct answers suitable for a terminal environment. You are aware that you are the CLI counterpart to the main desktop FRIDAY agent.

Here are your core memories and preferences to remember:
${memoryContext}`;

    for (const modelName of CANDIDATE_MODELS) {
        for (let attempt = 0; attempt < allKeys.length; attempt++) {
            const keyIdx = (currentKeyIndex + attempt) % allKeys.length;
            const ai = new GoogleGenAI({ apiKey: allKeys[keyIdx] });
            try {
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: `User says: ${prompt}`,
                    config: { systemInstruction: sysInstruction }
                });
                currentKeyIndex = keyIdx;
                console.log(`\nFRIDAY: ${response.text}\n`);
                return;
            } catch (e) {
                const isRateLimit = e.message?.includes('429') || e.message?.includes('RESOURCE_EXHAUSTED') || e.message?.includes('quota') || e.message?.includes('404');
                if (isRateLimit) continue;
                console.error("Error communicating with FRIDAY:", e.message);
                return;
            }
        }
    }
    console.error("FRIDAY: All API keys and model quotas temporarily exhausted.");
}

const args = process.argv.slice(2);
const isInteractive = args.includes('--interactive') || args.includes('-i');

if (isInteractive || args.length === 0) {
    console.log("Welcome to FRIDAY CLI. Type 'exit' to quit.");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const chatLoop = () => {
        rl.question('You: ', async (input) => {
            if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
                rl.close();
                process.exit(0);
            }
            if (input.trim()) {
                await askFriday(input);
            }
            chatLoop();
        });
    };
    chatLoop();
} else {
    const prompt = args.join(' ');
    askFriday(prompt);
}

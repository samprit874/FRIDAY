const { GoogleGenAI, Type } = require('@google/genai');
const { randomUUID: uuidv4 } = require('crypto');

function getGeminiApiKey() {
    const fs = require('fs');
    const path = require('path');
    const secretsPath = path.join(__dirname, '..', 'secrets.json');
    if (fs.existsSync(secretsPath)) {
        try {
            const sec = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
            if (sec.geminiApiKey) return sec.geminiApiKey;
            if (sec.geminiApiKeys && sec.geminiApiKeys.length > 0) return sec.geminiApiKeys[0];
        } catch (e) {}
    }
    return process.env.GEMINI_API_KEY;
}

class SubAgentManager {
    constructor() {
        this.activeAgents = new Map();
    }

    async spawnSubAgent(name, goal, context, tools = []) {
        const agentId = uuidv4();
        const apiKey = getGeminiApiKey();
        if (!apiKey) {
            return { success: false, error: "No Gemini API Key available for subagent." };
        }

        const agentRecord = {
            id: agentId,
            name,
            goal,
            status: 'running',
            startedAt: new Date().toISOString(),
            result: null
        };
        this.activeAgents.set(agentId, agentRecord);

        // Run asynchronously
        this._runAgent(agentRecord, apiKey, context, tools).catch(e => {
            agentRecord.status = 'failed';
            agentRecord.result = e.message;
        });

        return { success: true, agentId, message: `Sub-agent ${name} spawned.` };
    }

    async _runAgent(agentRecord, apiKey, context, tools) {
        const ai = new GoogleGenAI({ apiKey });
        const systemInstruction = `You are a specialized sub-agent named ${agentRecord.name}. 
Your goal is: ${agentRecord.goal}
Context provided: ${context}
Please analyze this and provide a comprehensive synthesis or result.`;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.5-flash',
                contents: systemInstruction,
                config: {
                    temperature: 0.2
                }
            });

            agentRecord.status = 'completed';
            agentRecord.result = response.text || "No output generated.";
            agentRecord.completedAt = new Date().toISOString();
        } catch (e) {
            agentRecord.status = 'failed';
            agentRecord.result = e.message;
            agentRecord.completedAt = new Date().toISOString();
        }
    }

    async spawnParallelSubAgents(tasks) {
        const apiKey = getGeminiApiKey();
        if (!apiKey) throw new Error("No Gemini API Key available.");

        const promises = tasks.map(async (task) => {
            const ai = new GoogleGenAI({ apiKey });
            const prompt = `You are a specialized sub-agent named ${task.name}. Your goal is: ${task.goal}\nContext: ${task.context}\nProvide a concise and accurate result.`;
            try {
                const res = await ai.models.generateContent({
                    model: 'gemini-3.5-flash',
                    contents: prompt,
                    config: { temperature: 0.2 }
                });
                return { name: task.name, status: 'success', result: res.text };
            } catch (e) {
                return { name: task.name, status: 'failed', error: e.message };
            }
        });

        const results = await Promise.all(promises);
        
        // Aggregate
        const synthesisPrompt = `You are the aggregator agent. You spawned multiple parallel subagents to solve a problem.
Here are their results:
${JSON.stringify(results, null, 2)}
Please synthesize these results into a single cohesive final answer.`;

        const ai = new GoogleGenAI({ apiKey });
        const finalRes = await ai.models.generateContent({
            model: 'gemini-3.5-pro',
            contents: synthesisPrompt
        });

        return { success: true, synthesis: finalRes.text, rawResults: results };
    }

    getSubAgentStatus(id) {
        const record = this.activeAgents.get(id);
        if (!record) return { success: false, error: 'Subagent not found' };
        return { success: true, data: record };
    }

    listSubAgents() {
        return Array.from(this.activeAgents.values());
    }
}

module.exports = new SubAgentManager();

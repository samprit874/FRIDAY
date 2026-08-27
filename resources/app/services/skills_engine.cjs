const fs = require('fs');
const path = require('path');
const { runCode } = require('./code_execution_engine.cjs');

const SKILLS_DIR = path.join(__dirname, '..', 'data', 'skills');

// Ensure skills directory exists
if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

class SkillsEngine {
    constructor() {
        this.skills = new Map();
        this.loadSkills();
    }

    loadSkills() {
        this.skills.clear();
        if (!fs.existsSync(SKILLS_DIR)) return;
        
        const files = fs.readdirSync(SKILLS_DIR);
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const content = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8');
                    const skill = JSON.parse(content);
                    this.skills.set(skill.id, skill);
                } catch (e) {
                    console.error(`Failed to load skill ${file}:`, e.message);
                }
            }
        }
    }

    createSkill(id, name, description, parameters, language, code, tags) {
        if (!id || !name || !language || !code) {
            throw new Error("Missing required fields: id, name, language, code");
        }

        const skill = {
            id,
            name,
            description: description || '',
            parameters: parameters || {}, // JSON schema for parameters
            language: language.toLowerCase(), // nodejs, python, powershell
            code,
            tags: tags || [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const filePath = path.join(SKILLS_DIR, `${id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8');
        this.skills.set(id, skill);
        
        return { success: true, message: `Skill ${id} created successfully`, skillId: id };
    }

    listSkills(filter = {}) {
        let result = Array.from(this.skills.values());
        
        if (filter.tag) {
            result = result.filter(s => s.tags.includes(filter.tag));
        }
        if (filter.language) {
            result = result.filter(s => s.language === filter.language);
        }
        
        return result.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            parameters: s.parameters,
            language: s.language,
            tags: s.tags
        }));
    }

    deleteSkill(id) {
        if (!this.skills.has(id)) {
            throw new Error(`Skill ${id} not found`);
        }
        const filePath = path.join(SKILLS_DIR, `${id}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        this.skills.delete(id);
        return { success: true, message: `Skill ${id} deleted successfully` };
    }

    async executeSkill(skillNameOrId, args) {
        let skill = this.skills.get(skillNameOrId);
        if (!skill) {
            // Try matching by name
            for (const s of this.skills.values()) {
                if (s.name.toLowerCase() === skillNameOrId.toLowerCase()) {
                    skill = s;
                    break;
                }
            }
        }

        if (!skill) {
            throw new Error(`Skill ${skillNameOrId} not found`);
        }

        console.log(`Executing skill ${skill.name} (${skill.language}) with args:`, args);
        
        // Use code_execution_engine to run the code
        // We pass the args which might be handled as environment variables or string replacements depending on the engine
        return await runCode(skill.language, skill.code, args);
    }
}

module.exports = new SkillsEngine();

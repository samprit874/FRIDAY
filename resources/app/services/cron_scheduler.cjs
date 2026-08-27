const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { randomUUID: uuidv4 } = require('crypto');
const skillsEngine = require('./skills_engine.cjs');
const { runTerminalCommand } = require('./code_execution_engine.cjs');

const CRON_TASKS_FILE = path.join(__dirname, '..', 'data', 'cron_tasks.json');

class CronScheduler {
    constructor() {
        this.tasks = new Map();
        this.activeJobs = new Map();
        
        // Ensure data directory exists
        const dataDir = path.dirname(CRON_TASKS_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        this.loadTasks();
    }

    loadTasks() {
        if (!fs.existsSync(CRON_TASKS_FILE)) {
            fs.writeFileSync(CRON_TASKS_FILE, JSON.stringify([]), 'utf8');
            return;
        }
        try {
            const data = JSON.parse(fs.readFileSync(CRON_TASKS_FILE, 'utf8'));
            for (const task of data) {
                this.tasks.set(task.id, task);
                if (task.enabled) {
                    this.startJob(task);
                }
            }
        } catch (e) {
            console.error('Failed to load cron tasks:', e);
        }
    }

    saveTasks() {
        const data = Array.from(this.tasks.values());
        fs.writeFileSync(CRON_TASKS_FILE, JSON.stringify(data, null, 2), 'utf8');
    }

    startJob(task) {
        if (!cron.validate(task.cronExpression)) {
            console.error(`Invalid cron expression for task ${task.id}: ${task.cronExpression}`);
            return false;
        }

        const job = cron.schedule(task.cronExpression, async () => {
            console.log(`Executing cron task: ${task.name} (${task.id})`);
            await this._executeTaskAction(task);
        });

        this.activeJobs.set(task.id, job);
        return true;
    }

    stopJob(taskId) {
        const job = this.activeJobs.get(taskId);
        if (job) {
            job.stop();
            this.activeJobs.delete(taskId);
        }
    }

    async _executeTaskAction(task) {
        let result = null;
        try {
            if (task.taskType === 'skill') {
                result = await skillsEngine.executeSkill(task.actionPayload.skillId, task.actionPayload.args || {});
            } else if (task.taskType === 'command') {
                result = await runTerminalCommand(task.actionPayload.command);
            } else {
                console.warn(`Unknown taskType ${task.taskType} for task ${task.id}`);
            }
            
            task.lastRun = new Date().toISOString();
            task.lastResult = result;
            this.saveTasks();

            // If a notifyTarget is provided, we could dispatch it to multiplatform gateway
            // e.g. require('./multiplatform_gateway.cjs').sendRemoteNotification(task.notifyTarget, result);
            if (task.notifyTarget) {
                const gateway = require('./multiplatform_gateway.cjs');
                if (gateway && gateway.sendRemoteNotification) {
                    let msg = `Cron Task **${task.name}** executed.\n`;
                    if (result && result.stdout) msg += `Output:\n${result.stdout}`;
                    await gateway.sendRemoteNotification(task.notifyTarget, msg);
                }
            }

        } catch (e) {
            console.error(`Cron task ${task.id} failed:`, e);
            task.lastRun = new Date().toISOString();
            task.lastResult = { success: false, error: e.message };
            this.saveTasks();
        }
    }

    scheduleTask(name, cronExpression, taskType, actionPayload, notifyTarget = null) {
        if (!cron.validate(cronExpression)) {
            throw new Error(`Invalid cron expression: ${cronExpression}`);
        }

        const taskId = uuidv4();
        const task = {
            id: taskId,
            name,
            cronExpression,
            taskType,
            actionPayload,
            notifyTarget,
            enabled: true,
            createdAt: new Date().toISOString(),
            lastRun: null,
            lastResult: null
        };

        this.tasks.set(taskId, task);
        this.saveTasks();
        this.startJob(task);

        return { success: true, taskId, message: `Scheduled task ${name} successfully.` };
    }

    listTasks() {
        return Array.from(this.tasks.values());
    }

    deleteTask(taskId) {
        if (!this.tasks.has(taskId)) {
            throw new Error(`Task ${taskId} not found`);
        }
        this.stopJob(taskId);
        this.tasks.delete(taskId);
        this.saveTasks();
        return { success: true, message: `Task ${taskId} deleted.` };
    }

    toggleTask(taskId, enabled) {
        const task = this.tasks.get(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);
        
        task.enabled = !!enabled;
        this.stopJob(taskId);
        if (task.enabled) {
            this.startJob(task);
        }
        this.saveTasks();
        return { success: true, message: `Task ${taskId} enabled state set to ${task.enabled}.` };
    }

    async runTaskNow(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);
        await this._executeTaskAction(task);
        return { success: true, message: `Task ${taskId} triggered immediately.` };
    }
}

module.exports = new CronScheduler();

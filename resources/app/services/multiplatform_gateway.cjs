const express = require('express');
const fs = require('fs');
const path = require('path');

class MultiPlatformGateway {
    constructor() {
        this.status = {
            telegram: 'inactive',
            discord: 'inactive',
            slack: 'inactive',
            webhook: 'active'
        };
        this.tokens = this._loadTokens();
        
        // Initialize bridges if tokens exist
        if (this.tokens.telegramBotToken) {
            this.status.telegram = 'active'; // Dummy initialization
        }
        if (this.tokens.discordBotToken) {
            this.status.discord = 'active'; // Dummy initialization
        }
        if (this.tokens.slackWebhookUrl) {
            this.status.slack = 'active'; // Dummy initialization
        }
    }

    _loadTokens() {
        try {
            const secretsPath = path.join(__dirname, '..', 'secrets.json');
            if (fs.existsSync(secretsPath)) {
                return JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
            }
        } catch (e) {
            console.error("Failed to load tokens for gateway:", e);
        }
        return {};
    }

    async sendRemoteNotification(platform, message) {
        platform = platform.toLowerCase();
        
        if (platform === 'slack' && this.tokens.slackWebhookUrl) {
            try {
                const res = await fetch(this.tokens.slackWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: message })
                });
                return { success: res.ok, message: `Dispatched to Slack: ${res.statusText}` };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }
        else if (platform === 'telegram' && this.tokens.telegramBotToken && this.tokens.telegramChatId) {
            try {
                const url = `https://api.telegram.org/bot${this.tokens.telegramBotToken}/sendMessage`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: this.tokens.telegramChatId, text: message })
                });
                return { success: res.ok, message: `Dispatched to Telegram: ${res.statusText}` };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }
        
        // Default to just logging if not configured
        console.log(`[RemoteGateway -> ${platform}] ${message}`);
        return { success: false, error: `Platform ${platform} is not fully configured or supported yet.` };
    }

    getGatewayStatus() {
        return this.status;
    }

    handleWebhook(req, res) {
        const payload = req.body;
        console.log("[Gateway Webhook Received]", payload);
        // Process incoming webhook payload from platforms like Signal or WhatsApp
        res.status(200).json({ status: 'received' });
    }
}

module.exports = new MultiPlatformGateway();

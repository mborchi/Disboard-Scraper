const DisboardScraper = require('./scraper');
const DiscordSender = require('./sender');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

class DisboardBot {
    constructor() {
        this.scraper = new DisboardScraper();
        this.sender = new DiscordSender();
        this.dataFile = path.join(__dirname, 'data', 'sent_links.json');
        this.textFile = path.join(__dirname, 'data', 'sent_links.txt');
        this.isRunning = false;
    }

    async initialize() {
        console.log('Disboard Scraper Botを初期化中...');
        
        // データディレクトリを作成
        await this.ensureDataDirectory();
        
        // 送信済みリンクを読み込み
        await this.loadSentLinks();
        
        // Discord送信機能を初期化
        await this.sender.initialize();
        
        console.log('初期化完了');
    }

    async ensureDataDirectory() {
        const dataDir = path.dirname(this.dataFile);
        try {
            await fs.access(dataDir);
        } catch {
            await fs.mkdir(dataDir, { recursive: true });
        }
    }

    async appendSentLinksTxt(invites) {
        if (!invites || invites.length === 0) {
            return;
        }

        const lines = invites.map(invite => {
            return invite.link;
        }).join('\n') + '\n';

        try {
            await fs.appendFile(this.textFile, lines, 'utf8');
            console.log(`TXTファイルに${invites.length}件を追記しました: ${this.textFile}`);
        } catch (error) {
            console.error('TXTファイルへの保存エラー:', error.message);
        }
    }

    async loadSentLinks() {
        try {
            const data = await fs.readFile(this.dataFile, 'utf8');
            const sentData = JSON.parse(data);
            this.sender.sentLinks = new Set(sentData);
            console.log(`${sentData.length}個の送信済みリンクを読み込みました`);
        } catch (error) {
            console.log('送信済みリンクファイルがありません。新規作成します');
            this.sender.sentLinks = new Set(); // Inicializar como Set vacío
            await this.saveSentLinks();
        }
    }

    async saveSentLinks() {
        try {
            const sentData = Array.from(this.sender.sentLinks);
            await fs.writeFile(this.dataFile, JSON.stringify(sentData, null, 2));
        } catch (error) {
            console.error('送信済みリンクの保存エラー:', error.message);
        }
    }

    async runScraping(options = {}) {
        if (this.isRunning) {
            console.log('スクレイピングは既に実行中です');
            return;
        }

        this.isRunning = true;
        console.log('=== スクレイピング開始 ===');

        try {
            // Disboardからサーバーをスクレイピング
            const maxPages = options.maxPages || 3;
            const category = options.category || null;
            
            let sentCount = 0;
            let newCount = 0;

            const onInviteFound = async (invite) => {
                // Si el enlace ya fue enviado, lo ignoramos de inmediato
                if (this.sender.sentLinks.has(invite.link)) {
                    return;
                }
                
                newCount++;
                console.log(`Sending invite now: ${invite.title} -> ${invite.link}`);
                const success = await this.sender.sendInvite(invite);
                if (!success) {
                    console.log(`送信失敗: ${invite.link}`);
                    return;
                }

                this.sender.sentLinks.add(invite.link);
                await this.saveSentLinks();
                await this.appendSentLinksTxt([invite]);
                sentCount++;
                console.log(`保存しました: ${invite.link}`);

                // 連続送信の間に少し待機
                await new Promise(resolve => setTimeout(resolve, 500));
            };
            
            // Pasamos nuestra función callback para que se ejecute página por página, enlace por enlace
            await this.scraper.scrapeMultiplePages(maxPages, category, onInviteFound);

            console.log(`=== スクレイピング完了 ===`);
            console.log(`${sentCount}/${newCount}個の新しい招待リンクを送信しました`);

        } catch (error) {
            console.error('スクレイピングエラー:', error);
        } finally {
            this.isRunning = false;
        }
    }

    startScheduler() {
        const interval = process.env.SCRAPE_INTERVAL_MINUTES || 30;
        const cronExpression = `*/${interval} * * * *`;
        
        console.log(`スケジューラーを開始します。間隔: ${interval}分`);
        
        cron.schedule(cronExpression, async () => {
            if (!this.isRunning) {
                await this.runScraping();
            }
        });

        // 初回実行
        setTimeout(() => this.runScraping(), 5000);
    }

    async shutdown() {
        console.log('シャットダウン中...');
        await this.saveSentLinks();
        await this.sender.close();
        console.log('シャットダウン完了');
    }
}

// メイン処理
async function main() {
    const bot = new DisboardBot();
    
    try {
        await bot.initialize();
        
        // コマンドライン引数でモードを切り替え
        const args = process.argv.slice(2);
        
        if (args.includes('--once')) {
            // 一回だけ実行
            await bot.runScraping({
                maxPages: parseInt(args.find(arg => arg.startsWith('--pages='))?.split('=')[1]) || 3,
                category: args.find(arg => arg.startsWith('--category='))?.split('=')[1] || null
            });
            await bot.shutdown();
        } else {
            // スケジューラーモード
            bot.startScheduler();
            
            // 終了シグナルを処理
            process.on('SIGINT', async () => {
                console.log('\\n終了シグナルを受信しました');
                await bot.shutdown();
                process.exit(0);
            });
            
            process.on('SIGTERM', async () => {
                console.log('\\n終了シグナルを受信しました');
                await bot.shutdown();
                process.exit(0);
            });
        }
        
    } catch (error) {
        console.error('起動エラー:', error);
        process.exit(1);
    }
}

// モジュールとしても利用可能
module.exports = DisboardBot;

if (require.main === module) {
    main();
}

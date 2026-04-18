const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
require('dotenv').config();

// Evitar warnings por muchos listeners en Puppeteer
require('events').EventEmitter.defaultMaxListeners = 50;

// Función para limitar concurrencia
async function limitConcurrency(tasks, limit) {
    const results = [];
    for (let i = 0; i < tasks.length; i += limit) {
        const batch = tasks.slice(i, i + limit);
        const batchResults = await Promise.allSettled(batch);
        results.push(...batchResults);

        // Pausa corta entre lotes para mantenerlo controlado
        if (i + limit < tasks.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    return results;
}

function sanitizeDiscordInviteUrl(url) {
    if (!url) return url;

    try {
        const parsed = new URL(url);
        parsed.search = '';
        return parsed.toString();
    } catch {
        return url;
    }
}

class DisboardScraper {
    constructor() {
        this.baseUrl = 'https://disboard.org/ja';
        this.inviteLinks = new Set();
        this.sentLinks = new Set();
        this.flaresolverrUrl = 'http://localhost:8191/v1';
    }

    async scrapeDisboardServers(page = 1, category = null) {
        console.log(`Disboardからサーバーをスクレイピング中... ページ: ${page}`);
        
        try {
            const baseUrls = [this.baseUrl, 'https://disboard.org/en', 'https://disboard.org/servers'];
            const flaresolverrUrl = 'http://localhost:8191/v1';
            let response = null;
            let lastError = null;

            const defaultHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
            };

            // Primero intentar petición directa en varios endpoints antes de usar FlareSolverr
            for (const baseUrl of baseUrls) {
                if (response) break;
                const directUrl = `${baseUrl}?page=${page}${category ? `&category=${category}` : ''}`;
                console.log(`Requesting Disboard page directly: ${directUrl}`);
                try {
                    const directResponse = await axios.get(directUrl, {
                        timeout: 40000,
                        headers: defaultHeaders
                    });

                    if (directResponse.status === 200 && typeof directResponse.data === 'string' && directResponse.data.includes('listing-card')) {
                        response = { data: { status: 'ok', solution: { response: directResponse.data } } };
                        console.log(`Direct request succeeded for ${directUrl}`);
                        break;
                    }

                    console.log(`Direct request did not return valid HTML for ${directUrl}`);
                } catch (error) {
                    lastError = error;
                    console.log(`Direct request failed for ${directUrl}: ${error.message}`);
                }
            }

            if (!response) {
                for (const baseUrl of baseUrls) {
                    let attemptUrl = `${baseUrl}?page=${page}`;
                    if (category) {
                        attemptUrl += `&category=${category}`;
                    }

                    console.log(`Requesting Disboard page via FlareSolverr: ${attemptUrl}`);

                    try {
                        const candidate = await axios.post(flaresolverrUrl, {
                            cmd: 'request.get',
                            url: attemptUrl,
                            maxTimeout: 70000,
                            returnOnlyBody: false,
                            headers: defaultHeaders
                        }, { timeout: 70000 });

                        if (candidate.data.status === 'ok') {
                            response = candidate;
                            break;
                        }

                        lastError = new Error(`FlareSolverr error: ${candidate.data.message}`);
                    } catch (error) {
                        lastError = error;
                        console.log(`FlareSolverr request failed for ${attemptUrl}: ${error.message}`);
                    }
                }
            }

            if (!response) {
                throw lastError || new Error('Disboard request failed for all methods');
            }
            
            const html = response.data.solution.response;
            const $ = cheerio.load(html);
            
            // Extraer servidores del HTML
            const servers = [];
            const listingCards = $('.listing-card').toArray();
            console.log(`Página recibida, servidores listados: ${listingCards.length}`);
            
            for (const element of listingCards) {
                const title = $(element).find('.server-name').text().trim();
                const description = $(element).find('.server-description').text().trim();
                const categoryText = $(element).find('.server-tags').text().trim();
                const classAttr = $(element).attr('class') || '';
                const serverIdMatch = classAttr.match(/server-(\d+)/);
                const serverId = serverIdMatch ? serverIdMatch[1] : null;

                if (!serverId) {
                    continue;
                }

                const joinUrl = `https://disboard.org/server/join/${serverId}`;
                console.log(`Fetching invite for server: ${title} (${joinUrl})`);
                const inviteLink = await this.getInviteFromJoinPage(joinUrl);
                if (!inviteLink) {
                    console.log(`No invite link found for server: ${title}`);
                    continue;
                }

                console.log(`Found invite for: ${title} -> ${inviteLink}`);
                servers.push({
                    title,
                    inviteLink,
                    description,
                    category: categoryText
                });
            }

            console.log(`${servers.length}個のサーバーを検出しました`);
            
            // Si no se encontraron servidores, loggear el HTML para depurar
            if (servers.length === 0) {
                console.log('HTML recibido (primeros 2000 caracteres):', html.substring(0, 2000));
                console.log('Buscando elementos .server-card:', $('.server-card').length);
                console.log('Buscando enlaces discord.gg:', $('a[href*="discord.gg"]').length);
                console.log('Todos los enlaces discord.gg:');
                $('a[href*="discord.gg"]').each((i, el) => {
                    console.log($(el).attr('href'), $(el).text().trim());
                });
                console.log('Elementos con clase que contiene "server":', $('[class*="server"]').length);
                $('[class*="server"]').each((i, el) => {
                    console.log('Clase:', $(el).attr('class'), 'Texto:', $(el).text().trim().substring(0, 100));
                });
            }
            
            // Agregar a inviteLinks
            servers.forEach(server => {
                this.inviteLinks.add({
                    title: server.title,
                    link: server.inviteLink,
                    description: server.description,
                    category: server.category,
                    scrapedAt: new Date().toISOString()
                });
            });
            
            return servers;
            
        } catch (error) {
            console.error('スクレイピングエラー:', error.message);
            return [];
        }
    }

    async scrapeMultiplePages(maxPages = 5, category = null) {
        console.log(`複数ページからスクレイピング開始... 最大${maxPages}ページ`);
        
        for (let page = 1; page <= maxPages; page++) {
            await this.scrapeDisboardServers(page, category);
            // 少しだけ待機してFlareSolverrを安定させる
            if (page < maxPages) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        console.log(`合計${this.inviteLinks.size}個の招待リンクを取得`);
        return Array.from(this.inviteLinks);
    }

    getNewInvites() {
        const allInvites = Array.from(this.inviteLinks);
        const newInvites = allInvites.filter(invite => 
            !this.sentLinks.has(invite.link)
        );
        
        return newInvites;
    }

    async getInviteFromJoinPage(joinUrl) {
        try {
            console.log(`Requesting join page via FlareSolverr: ${joinUrl}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // Increased to 30s

            let response;
            try {
                response = await axios.post(this.flaresolverrUrl, {
                    cmd: 'request.get',
                    url: joinUrl,
                    maxTimeout: 20000,
                    returnOnlyBody: false,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
                    }
                }, { timeout: 20000, signal: controller.signal });
            } finally {
                clearTimeout(timeoutId);
            }
            console.log(`FlareSolverr response for ${joinUrl}: status=${response.status} flare=${response.data.status}`);


            if (response.data.status !== 'ok') {
                throw new Error(`FlareSolverr error: ${response.data.message}`);
            }

            const solution = response.data.solution || {};
            const finalUrl = solution.url || '';
            if (finalUrl.includes('discord.gg') || finalUrl.includes('discord.com/invite')) {
                return sanitizeDiscordInviteUrl(finalUrl);
            }

            const html = solution.response || '';
            const $ = cheerio.load(html);

            const inviteLink = $('a[href*="discord.gg"]').attr('href') || $('a[href*="discord.com/invite"]').attr('href');
            if (inviteLink) {
                return sanitizeDiscordInviteUrl(inviteLink);
            }

            const canonicalLink = $('link[rel="canonical"]').attr('href');
            if (canonicalLink && (canonicalLink.includes('discord.gg') || canonicalLink.includes('discord.com/invite'))) {
                return sanitizeDiscordInviteUrl(canonicalLink);
            }

            const ogUrl = $('meta[property="og:url"]').attr('content') || $('meta[name="twitter:url"]').attr('content');
            if (ogUrl && (ogUrl.includes('discord.gg') || ogUrl.includes('discord.com/invite'))) {
                return sanitizeDiscordInviteUrl(ogUrl);
            }

            const allDiscordLinks = $('a').map((i, el) => $(el).attr('href')).get().filter(h => h && (h.includes('discord.gg') || h.includes('discord.com/invite')));
            if (allDiscordLinks.length > 0) {
                return sanitizeDiscordInviteUrl(allDiscordLinks[0]);
            }

            console.log(`No direct discord invite found on join page: ${joinUrl}`);
            console.log(`Final URL: ${finalUrl}`);
            console.log(`Join page HTML snippet: ${html.substring(0, 1500)}`);
            return null;
        } catch (error) {
            if (error.name === 'AbortError') {
                console.error('FlareSolverr request timed out for join page:', joinUrl);
            } else {
                console.error('Error fetching join page with FlareSolverr:', error.message);
            }
            return null;
        }
    }
}

module.exports = DisboardScraper;

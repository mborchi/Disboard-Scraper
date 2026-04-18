import os
import json
import asyncio
import discord
from discord.ext import tasks
from scraper import fetch_servers
from webserver import start_webserver
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
CHANNEL_ID = os.getenv("CHANNEL_ID")

if not TOKEN or not CHANNEL_ID:
    raise ValueError("環境変数 DISCORD_TOKEN または CHANNEL_ID が未設定")

CHANNEL_ID = int(CHANNEL_ID)

POSTED_FILE = "posted.json"

intents = discord.Intents.default()
client = discord.Client(intents=intents)

if os.path.exists(POSTED_FILE):
    with open(POSTED_FILE, "r") as f:
        posted = json.load(f)
else:
    posted = []

@client.event
async def on_ready():
    print(f"✅ Logged in as {client.user}")
    check_updates.start()

@tasks.loop(minutes=30)
async def check_updates():
    await client.wait_until_ready()
    channel = client.get_channel(CHANNEL_ID)

    if channel is None:
        print("Channel not found")
        return

    servers = fetch_servers()
    if not servers:
        return

    new_posts = []

    for server in servers:
        if server["invite"] not in posted:
            new_posts.append(server)
            posted.append(server["invite"])

    if new_posts:
        for s in new_posts:
            embed = discord.Embed(
                title=s["name"],
                description=(s["description"][:200] or "説明なし"),
                url=s["invite"],
                color=0x5865F2
            )
            embed.add_field(name="タグ", value=", ".join(s["tags"]) or "なし")
            await channel.send(embed=embed)
            await asyncio.sleep(2)

        with open(POSTED_FILE, "w") as f:
            json.dump(posted, f)

start_webserver()
client.run(TOKEN)

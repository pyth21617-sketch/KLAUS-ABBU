import makeWASocket, { useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion, Browsers, downloadMediaMessage, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
const BROWSER_CONFIG = Browsers.macOS('Chrome');
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import gtts from 'node-gtts';
import { spawn } from 'child_process';
import SpottyDL from 'spottydl-better';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

// Gemini AI - the newest model is gemini-2.5-flash
const geminiAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

async function askGemini(prompt) {
    try {
        const response = await geminiAI.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        return response.text || 'No response from AI';
    } catch (err) {
        console.error('Gemini AI error:', err.message);
        return 'AI error: ' + err.message;
    }
}

const SESSION_NUMBER = process.argv[2];

if (!SESSION_NUMBER) {
    console.log('╔══════════════════════════════════════╗');
    console.log('║      RISH ⟁ BOT - SESSION MODE       ║');
    console.log('╠══════════════════════════════════════╣');
    console.log('║  Usage: node thunder [session_number]║');
    console.log('║                                      ║');
    console.log('║  Examples:                           ║');
    console.log('║    node thunder 1                    ║');
    console.log('║    node thunder 2                    ║');
    console.log('║    node thunder 3                    ║');
    console.log('║    node thunder 4                    ║');
    console.log('╚══════════════════════════════════════╝');
    process.exit(1);
}

const SESSION_ID = `SESSION_${SESSION_NUMBER}`;
const AUTH_PATH = `./sessions/${SESSION_ID}`;

const OWNER_JID = '917044676908@s.whatsapp.net';
const OWNER_NUMBER = '917044676908';

const ROLES_FILE = './data/roles.json';
const DELAYS_FILE = './data/ncDelays.json';
const LID_MAP_FILE = './data/lidMap.json';

let lidToPhoneMap = {};

function loadLidMap() {
    let map = {};
    
    try {
        if (fs.existsSync(LID_MAP_FILE)) {
            const data = fs.readFileSync(LID_MAP_FILE, 'utf8');
            map = { ...map, ...JSON.parse(data) };
        }
    } catch (err) {
        console.log(`[${SESSION_ID}] Error loading LID map from data file`);
    }
    
    try {
        if (fs.existsSync('./sessions')) {
            const sessionDirs = fs.readdirSync('./sessions').filter(d => d.startsWith('SESSION_'));
            for (const sessionDir of sessionDirs) {
                const authDir = `./sessions/${sessionDir}`;
                if (!fs.existsSync(authDir)) continue;
                
                const files = fs.readdirSync(authDir);
                for (const file of files) {
                    if (file.startsWith('lid-mapping-') && file.endsWith('.json') && !file.includes('_reverse')) {
                        const phoneNumber = file.replace('lid-mapping-', '').replace('.json', '');
                        try {
                            const lidData = fs.readFileSync(`${authDir}/${file}`, 'utf8');
                            const lid = JSON.parse(lidData);
                            if (lid && phoneNumber) {
                                const lidJid = `${lid}@lid`;
                                map[lidJid] = phoneNumber;
                                console.log(`[${SESSION_ID}] Loaded mapping: ${lidJid} -> ${phoneNumber}`);
                            }
                        } catch (e) {}
                    }
                }
            }
        }
    } catch (err) {
        console.log(`[${SESSION_ID}] Error loading LID mappings from sessions folders`);
    }
    
    return map;
}

function saveLidMap() {
    try {
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data', { recursive: true });
        }
        fs.writeFileSync(LID_MAP_FILE, JSON.stringify(lidToPhoneMap, null, 2));
    } catch (err) {
        console.error(`[${SESSION_ID}] Error saving LID map:`, err.message);
    }
}

function registerLidMapping(lid, phoneJid) {
    if (lid && phoneJid && lid.endsWith('@lid') && phoneJid.includes('@')) {
        const phoneNumber = phoneJid.split('@')[0];
        if (phoneNumber && !isNaN(phoneNumber)) {
            lidToPhoneMap[lid] = phoneNumber;
            saveLidMap();
            console.log(`[${SESSION_ID}] Mapped ${lid} -> ${phoneNumber}`);
        }
    }
}

function resolveToPhoneNumber(jid) {
    if (!jid) return null;
    
    if (jid.endsWith('@s.whatsapp.net')) {
        return jid.split('@')[0];
    }
    
    if (jid.endsWith('@lid')) {
        return lidToPhoneMap[jid] || null;
    }
    
    return null;
}

function findLidsForPhoneNumber(phoneNumber) {
    const lids = [];
    for (const [lid, phone] of Object.entries(lidToPhoneMap)) {
        if (phone === phoneNumber) {
            lids.push(lid);
        }
    }
    return lids;
}

lidToPhoneMap = loadLidMap();

const defaultRoles = {
    admins: [OWNER_JID],
    subAdmins: {},
    globalSubAdmins: []
};

const defaultDelays = {
    nc1: 200,
    nc2: 200,
    nc3: 200,
    nc4: 200,
    nc5: 200,
    nc6: 200,
    nc7: 200,
    nc8: 200
};

function normalizeJidOnLoad(jid) {
    if (!jid) return jid;
    const phoneNumber = resolveToPhoneNumber(jid);
    if (phoneNumber) {
        return `${phoneNumber}@s.whatsapp.net`;
    }
    return jid;
}

function loadRoles() {
    try {
        if (fs.existsSync(ROLES_FILE)) {
            const data = fs.readFileSync(ROLES_FILE, 'utf8');
            const loaded = JSON.parse(data);
            
            loaded.admins = [...new Set(loaded.admins.map(normalizeJidOnLoad))];
            if (!loaded.admins.includes(OWNER_JID)) {
                loaded.admins.push(OWNER_JID);
            }
            
            if (!loaded.globalSubAdmins) {
                loaded.globalSubAdmins = [];
            } else {
                loaded.globalSubAdmins = [...new Set(loaded.globalSubAdmins.map(normalizeJidOnLoad))];
            }
            
            if (loaded.subAdmins) {
                for (const groupJid in loaded.subAdmins) {
                    loaded.subAdmins[groupJid] = [...new Set(loaded.subAdmins[groupJid].map(normalizeJidOnLoad))];
                }
            }
            
            return loaded;
        }
    } catch (err) {
        console.log(`[${SESSION_ID}] Error loading roles, using defaults`);
    }
    return { ...defaultRoles };
}

function saveRoles(roles) {
    try {
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data', { recursive: true });
        }
        fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2));
    } catch (err) {
        console.error(`[${SESSION_ID}] Error saving roles:`, err.message);
    }
}

function loadDelays() {
    try {
        if (fs.existsSync(DELAYS_FILE)) {
            const data = fs.readFileSync(DELAYS_FILE, 'utf8');
            return { ...defaultDelays, ...JSON.parse(data) };
        }
    } catch (err) {
        console.log(`[${SESSION_ID}] Error loading delays, using defaults`);
    }
    return { ...defaultDelays };
}

function saveDelays(delays) {
    try {
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data', { recursive: true });
        }
        fs.writeFileSync(DELAYS_FILE, JSON.stringify(delays, null, 2));
    } catch (err) {
        console.error(`[${SESSION_ID}] Error saving delays:`, err.message);
    }
}

let roles = loadRoles();
let ncDelays = loadDelays();

function isOwner(jid) {
    if (jid === OWNER_JID) return true;
    
    const phoneNumber = resolveToPhoneNumber(jid);
    if (phoneNumber === OWNER_NUMBER) return true;
    
    if (jid && jid.split('@')[0] === OWNER_NUMBER) return true;
    
    return false;
}

function isAdmin(jid) {
    if (roles.admins.includes(jid)) return true;
    
    const phoneNumber = resolveToPhoneNumber(jid);
    if (phoneNumber) {
        const phoneJid = `${phoneNumber}@s.whatsapp.net`;
        if (roles.admins.includes(phoneJid)) return true;
        
        // Check if any LID mapping to this phone number is in the list
        const lids = findLidsForPhoneNumber(phoneNumber);
        for (const lid of lids) {
            if (roles.admins.includes(lid)) return true;
        }
    }
    
    return false;
}

function isGlobalSubAdmin(jid) {
    if (roles.globalSubAdmins?.includes(jid)) return true;
    
    const phoneNumber = resolveToPhoneNumber(jid);
    if (phoneNumber) {
        const phoneJid = `${phoneNumber}@s.whatsapp.net`;
        if (roles.globalSubAdmins?.includes(phoneJid)) return true;
        
        // Check if any LID mapping to this phone number is in the list
        const lids = findLidsForPhoneNumber(phoneNumber);
        for (const lid of lids) {
            if (roles.globalSubAdmins?.includes(lid)) return true;
        }
    }
    
    return false;
}

function isSubAdmin(jid, groupJid) {
    if (roles.subAdmins[groupJid]?.includes(jid)) return true;
    
    const phoneNumber = resolveToPhoneNumber(jid);
    if (phoneNumber) {
        const phoneJid = `${phoneNumber}@s.whatsapp.net`;
        if (roles.subAdmins[groupJid]?.includes(phoneJid)) return true;
    }
    
    return false;
}

function hasPermission(jid, groupJid) {
    return isAdmin(jid) || isGlobalSubAdmin(jid) || isSubAdmin(jid, groupJid);
}

function normalizeJid(jid) {
    if (!jid) return jid;
    const phoneNumber = resolveToPhoneNumber(jid);
    if (phoneNumber) {
        return `${phoneNumber}@s.whatsapp.net`;
    }
    return jid;
}

function addAdmin(jid) {
    const normalizedJid = normalizeJid(jid);
    if (!roles.admins.includes(normalizedJid)) {
        roles.admins.push(normalizedJid);
        saveRoles(roles);
        return true;
    }
    return false;
}

function removeAdmin(jid) {
    const normalizedJid = normalizeJid(jid);
    if (normalizedJid === OWNER_JID) return false;
    const index = roles.admins.indexOf(normalizedJid);
    if (index > -1) {
        roles.admins.splice(index, 1);
        saveRoles(roles);
        return true;
    }
    return false;
}

function addGlobalSubAdmin(jid) {
    const normalizedJid = normalizeJid(jid);
    if (!roles.globalSubAdmins) {
        roles.globalSubAdmins = [];
    }
    if (!roles.globalSubAdmins.includes(normalizedJid)) {
        roles.globalSubAdmins.push(normalizedJid);
        saveRoles(roles);
        return true;
    }
    return false;
}

function removeGlobalSubAdmin(jid) {
    const normalizedJid = normalizeJid(jid);
    if (roles.globalSubAdmins) {
        const index = roles.globalSubAdmins.indexOf(normalizedJid);
        if (index > -1) {
            roles.globalSubAdmins.splice(index, 1);
            saveRoles(roles);
            return true;
        }
    }
    return false;
}

function addSubAdmin(jid, groupJid) {
    const normalizedJid = normalizeJid(jid);
    if (!roles.subAdmins[groupJid]) {
        roles.subAdmins[groupJid] = [];
    }
    if (!roles.subAdmins[groupJid].includes(normalizedJid)) {
        roles.subAdmins[groupJid].push(normalizedJid);
        saveRoles(roles);
        return true;
    }
    return false;
}

function removeSubAdmin(jid, groupJid) {
    const normalizedJid = normalizeJid(jid);
    if (roles.subAdmins[groupJid]) {
        const index = roles.subAdmins[groupJid].indexOf(normalizedJid);
        if (index > -1) {
            roles.subAdmins[groupJid].splice(index, 1);
            saveRoles(roles);
            return true;
        }
    }
    return false;
}

const emojiArrays = {
    nc1: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '😍', '🥰'],
    nc2: ['💋', '❤️', '🩶', '🤍', '🩷', '💘', '💝', '💝', '❤️‍🩹', '💔', '❤️‍🔥', '💓', '💗'],
    nc3: ['👍', '👎', '🫶', '🙌', '👐', '🤲', '🤜', '🤛', '✊', '👊', '🫳', '🫴', '🫱', '🫲'],
    nc4: ['💐', '🌹', '🥀', '🌺', '🌷', '🪷', '🌸', '💮', '🏵️', '🪻', '🌻', '🌼'],
    nc5: ['☀️', '🌞', '🌝', '🌚', '🌜', '🌛', '🌙', '⭐', '🌟', '✨', '🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
    nc6: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🏍️', '🛵', '🚲', '🛴'],
    nc7: ['🦁', '🐯', '🐱', '🐺', '🙈', '🐮', '🐷', '🦄', '🦚', '🐳', '🐋', '🐋', '🐬', '🦈'],
    nc8: ['🍓', '🍒', '🍎', '🍅', '🌶️', '🍉', '🍑', '🍊', '🥕', '🥭', '🍍', '🍌', '🌽', '🍋', '🍋‍🟩', '🍈', '🍐', '🫛', '🍆', '🍇']
};

const gouravMenu = `
*━━━ RISH ⟁ BOT [${SESSION_ID}] ━━━*

*ADMIN*
+admin | -admin
+sub | -sub (reply)
+addsub @ | -remsub @

*NC ATTACKS*
+nc1-8 [text]
+delaync1-8 [ms]
-nc (stop)

*MESSAGE*
+s [text] [delay] | -s
+txt [text] [delay] | -txt

*TTS*
+tts [text]
+ttsify [song] (spotify vn)
+ttsatk [text] [delay] | -ttsatk

*PICTURE*
+pic [delay] | -pic

*AUTO REPLY*
+reply [text] (reply to msg)
-reply (stop)

*AI POWERED*
+ai [question]

*CONTROL*
-all | +status | +menu | +ping
`;

async function generateTTS(text, lang = 'en') {
    return new Promise((resolve, reject) => {
        const tts = gtts(lang);
        const mp3Chunks = [];
        
        tts.stream(text).on('data', (chunk) => {
            mp3Chunks.push(chunk);
        }).on('end', () => {
            const mp3Buffer = Buffer.concat(mp3Chunks);
            
            const ffmpeg = spawn('ffmpeg', [
                '-i', 'pipe:0',
                '-c:a', 'libopus',
                '-b:a', '128k',
                '-ar', '48000',
                '-ac', '1',
                '-application', 'voip',
                '-f', 'ogg',
                'pipe:1'
            ]);
            
            const oggChunks = [];
            
            ffmpeg.stdout.on('data', (chunk) => {
                oggChunks.push(chunk);
            });
            
            ffmpeg.stderr.on('data', () => {});
            
            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve(Buffer.concat(oggChunks));
                } else {
                    resolve(mp3Buffer);
                }
            });
            
            ffmpeg.on('error', () => {
                resolve(mp3Buffer);
            });
            
            ffmpeg.stdin.write(mp3Buffer);
            ffmpeg.stdin.end();
        }).on('error', (err) => {
            reject(err);
        });
    });
}

async function downloadSpotifyAsVoiceNote(query) {
    const tempDir = './temp_spotify';
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    try {
        let trackInfo;
        
        if (query.includes('spotify.com/track/')) {
            trackInfo = await SpottyDL.getTrack(query);
        } else {
            const searchResults = await SpottyDL.search(query);
            if (!searchResults || searchResults.length === 0) {
                throw new Error('No tracks found');
            }
            trackInfo = searchResults[0];
        }
        
        if (!trackInfo) {
            throw new Error('Could not get track info');
        }
        
        const trackName = trackInfo.name || 'Unknown';
        const artistName = trackInfo.artists?.[0] || 'Unknown';
        
        const downloadResult = await SpottyDL.downloadTrack(trackInfo, tempDir);
        
        if (!downloadResult || downloadResult.length === 0 || downloadResult[0].status !== 'Success') {
            throw new Error('Download failed');
        }
        
        const mp3Path = path.join(tempDir, downloadResult[0].filename);
        const mp3Buffer = fs.readFileSync(mp3Path);
        
        const oggBuffer = await new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', [
                '-i', 'pipe:0',
                '-c:a', 'libopus',
                '-b:a', '320k',
                '-ar', '48000',
                '-ac', '2',
                '-application', 'audio',
                '-vbr', 'on',
                '-compression_level', '10',
                '-f', 'ogg',
                'pipe:1'
            ]);
            
            const oggChunks = [];
            
            ffmpeg.stdout.on('data', (chunk) => {
                oggChunks.push(chunk);
            });
            
            ffmpeg.stderr.on('data', () => {});
            
            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve(Buffer.concat(oggChunks));
                } else {
                    reject(new Error('FFmpeg conversion failed'));
                }
            });
            
            ffmpeg.on('error', (err) => {
                reject(err);
            });
            
            ffmpeg.stdin.write(mp3Buffer);
            ffmpeg.stdin.end();
        });
        
        try {
            fs.unlinkSync(mp3Path);
        } catch (e) {}
        
        return {
            buffer: oggBuffer,
            trackName,
            artistName
        };
    } catch (err) {
        throw err;
    }
}

const activeNameChanges = new Map();
const activeSlides = new Map();
const activeTxtSenders = new Map();
const activeTTSSenders = new Map();
const activePicSenders = new Map();
const activeAutoReplies = new Map();

const msgRetryCounterCache = new Map();
const messageStore = new Map();

function bindStoreToSocket(sock) {
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (msg.key?.id && msg.message) {
                messageStore.set(msg.key.id, msg.message);
                if (messageStore.size > 5000) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }
        }
    });
}

async function getMessage(key) {
    return messageStore.get(key.id);
}

let sock = null;
let connected = false;
let botNumber = null;

async function sendMessage(jid, text, mentions = []) {
    if (!sock || !connected) return;
    try {
        const message = { text };
        if (mentions.length > 0) {
            message.mentions = mentions;
        }
        await sock.sendMessage(jid, message);
    } catch (err) {
        console.error(`[${SESSION_ID}] Send message error:`, err.message);
    }
}

async function executeCommand(commandType, data) {
    try {
        if (commandType === 'start_nc') {
            const { from, nameText, ncKey } = data;
            const emojis = emojiArrays[ncKey];
            const nameDelay = ncDelays[ncKey];
            
            for (let i = 0; i < 5; i++) {
                const taskId = `${from}_${ncKey}_${i}`;
                if (activeNameChanges.has(taskId)) {
                    activeNameChanges.delete(taskId);
                    await delay(100);
                }

                let emojiIndex = i * Math.floor(emojis.length / 5);
                
                const runLoop = async () => {
                    activeNameChanges.set(taskId, true);
                    await delay(i * 200);
                    while (activeNameChanges.get(taskId) && connected && sock) {
                        try {
                            const emoji = emojis[Math.floor(emojiIndex) % emojis.length];
                            const newName = `${nameText} ${emoji}`;
                            await sock.groupUpdateSubject(from, newName);
                            emojiIndex++;
                            await delay(nameDelay);
                        } catch (err) {
                            if (err.message?.includes('rate-overlimit')) {
                                await delay(3000);
                            } else {
                                await delay(nameDelay);
                            }
                        }
                    }
                };

                runLoop();
            }

            await sendMessage(from, `*RISH ⟁ ${ncKey.toUpperCase()}* started | ${nameText} | ${nameDelay}ms`);
        }
        else if (commandType === 'stop_nc') {
            const { from } = data;
            let stopped = 0;
            
            activeNameChanges.forEach((value, taskId) => {
                if (taskId.startsWith(from)) {
                    activeNameChanges.set(taskId, false);
                    activeNameChanges.delete(taskId);
                    stopped++;
                }
            });

            if (stopped > 0) {
                await sendMessage(from, `*RISH ⟁* NC stopped | ${stopped} threads`);
            }
        }
        else if (commandType === 'start_slide') {
            const { from, slideText, slideDelay, quotedParticipant, quotedMsgId, quotedMessage } = data;
            
            const taskId = `${from}_${quotedParticipant}`;
            
            if (activeSlides.has(taskId)) {
                activeSlides.get(taskId).active = false;
                await delay(200);
            }

            const slideTask = {
                targetJid: quotedParticipant,
                text: slideText,
                groupJid: from,
                latestMsg: {
                    key: {
                        remoteJid: from,
                        fromMe: false,
                        id: quotedMsgId,
                        participant: quotedParticipant
                    },
                    message: quotedMessage
                },
                hasNewMsg: true,
                lastRepliedId: null,
                active: true
            };

            activeSlides.set(taskId, slideTask);

            const runSlide = async () => {
                while (slideTask.active && connected && sock) {
                    try {
                        await sock.sendMessage(from, { 
                            text: slideText 
                        }, { 
                            quoted: slideTask.latestMsg
                        });
                    } catch (err) {
                        console.error(`[${SESSION_ID}] SLIDE Error:`, err.message);
                    }
                    await delay(slideDelay);
                }
            };

            runSlide();

            await sendMessage(from, `*RISH ⟁ SLIDE* started | ${slideText} | ${slideDelay}ms`);
        }
        else if (commandType === 'stop_slide') {
            const { from } = data;
            let stopped = 0;
            activeSlides.forEach((task, taskId) => {
                if (task.groupJid === from) {
                    task.active = false;
                    activeSlides.delete(taskId);
                    stopped++;
                }
            });

            if (stopped > 0) {
                await sendMessage(from, `*RISH ⟁* slide stopped | ${stopped} attack(s)`);
            }
        }
        else if (commandType === 'start_txt') {
            const { from, txtText, txtDelay } = data;
            
            const taskId = `${from}_txt`;
            
            if (activeTxtSenders.has(taskId)) {
                activeTxtSenders.get(taskId).active = false;
                await delay(200);
            }

            const txtTask = { active: true };
            activeTxtSenders.set(taskId, txtTask);

            const runTxt = async () => {
                while (txtTask.active && connected && sock) {
                    try {
                        await sock.sendMessage(from, { text: txtText });
                    } catch (err) {
                        console.error(`[${SESSION_ID}] TXT Error:`, err.message);
                    }
                    await delay(txtDelay);
                }
            };

            runTxt();

            await sendMessage(from, `*RISH ⟁ TXT* started | ${txtText} | ${txtDelay}ms`);
        }
        else if (commandType === 'stop_txt') {
            const { from } = data;
            const taskId = `${from}_txt`;
            if (activeTxtSenders.has(taskId)) {
                activeTxtSenders.get(taskId).active = false;
                activeTxtSenders.delete(taskId);
                await sendMessage(from, `✅ Text attack stopped - ${SESSION_ID}`);
            }
        }
        else if (commandType === 'start_tts') {
            const { from, ttsText, ttsDelay } = data;
            
            const taskId = `${from}_tts`;
            
            if (activeTTSSenders.has(taskId)) {
                activeTTSSenders.get(taskId).active = false;
                await delay(200);
            }

            const ttsTask = { active: true };
            activeTTSSenders.set(taskId, ttsTask);

            const runTTS = async () => {
                while (ttsTask.active && connected && sock) {
                    try {
                        const audioBuffer = await generateTTS(ttsText);
                        await sock.sendMessage(from, {
                            audio: audioBuffer,
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true
                        });
                    } catch (err) {
                        console.error(`[${SESSION_ID}] TTS Error:`, err.message);
                    }
                    await delay(ttsDelay);
                }
            };

            runTTS();

            await sendMessage(from, `*RISH ⟁ TTS* started | ${ttsText} | ${ttsDelay}ms`);
        }
        else if (commandType === 'stop_tts') {
            const { from } = data;
            const taskId = `${from}_tts`;
            if (activeTTSSenders.has(taskId)) {
                activeTTSSenders.get(taskId).active = false;
                activeTTSSenders.delete(taskId);
                await sendMessage(from, `✅ TTS attack stopped - ${SESSION_ID}`);
            }
        }
        else if (commandType === 'start_pic') {
            const { from, picDelay, imageBuffer, mimetype } = data;
            
            const taskId = `${from}_pic`;
            
            if (activePicSenders.has(taskId)) {
                activePicSenders.get(taskId).active = false;
                await delay(200);
            }

            const picTask = { active: true, buffer: Buffer.from(imageBuffer, 'base64'), mimetype };
            activePicSenders.set(taskId, picTask);

            const runPic = async () => {
                while (picTask.active && connected && sock) {
                    try {
                        await sock.sendMessage(from, {
                            image: picTask.buffer,
                            mimetype: picTask.mimetype
                        });
                    } catch (err) {
                        console.error(`[${SESSION_ID}] PIC Error:`, err.message);
                    }
                    await delay(picDelay);
                }
            };

            runPic();

            await sendMessage(from, `*RISH ⟁ PIC* started | ${picDelay}ms`);
        }
        else if (commandType === 'stop_pic') {
            const { from } = data;
            const taskId = `${from}_pic`;
            if (activePicSenders.has(taskId)) {
                activePicSenders.get(taskId).active = false;
                activePicSenders.delete(taskId);
                await sendMessage(from, `✅ Pic attack stopped - ${SESSION_ID}`);
            }
        }
        else if (commandType === 'start_reply') {
            const { from, replyText, targetJid } = data;
            const taskId = `${from}_${targetJid}`;
            
            activeAutoReplies.set(taskId, {
                targetJid,
                replyText,
                chatJid: from,
                active: true
            });
            
            await sendMessage(from, `*RISH ⟁ AUTO-REPLY* started | Target: @${targetJid.split('@')[0]}`, [targetJid]);
        }
        else if (commandType === 'stop_reply') {
            const { from } = data;
            let stopped = 0;
            
            activeAutoReplies.forEach((task, taskId) => {
                if (taskId.startsWith(from)) {
                    activeAutoReplies.delete(taskId);
                    stopped++;
                }
            });
            
            if (stopped > 0) {
                await sendMessage(from, `✅ Auto-reply stopped | ${stopped} target(s) - ${SESSION_ID}`);
            }
        }
        else if (commandType === 'stop_all') {
            const { from } = data;
            let stopped = 0;
            
            activeNameChanges.forEach((value, taskId) => {
                if (taskId.startsWith(from)) {
                    activeNameChanges.set(taskId, false);
                    activeNameChanges.delete(taskId);
                    stopped++;
                }
            });
            
            activeSlides.forEach((task, taskId) => {
                if (task.groupJid === from) {
                    task.active = false;
                    activeSlides.delete(taskId);
                    stopped++;
                }
            });
            
            const txtTaskId = `${from}_txt`;
            if (activeTxtSenders.has(txtTaskId)) {
                activeTxtSenders.get(txtTaskId).active = false;
                activeTxtSenders.delete(txtTaskId);
                stopped++;
            }

            const ttsTaskId = `${from}_tts`;
            if (activeTTSSenders.has(ttsTaskId)) {
                activeTTSSenders.get(ttsTaskId).active = false;
                activeTTSSenders.delete(ttsTaskId);
                stopped++;
            }

            const picTaskId = `${from}_pic`;
            if (activePicSenders.has(picTaskId)) {
                activePicSenders.get(picTaskId).active = false;
                activePicSenders.delete(picTaskId);
                stopped++;
            }
            
            activeAutoReplies.forEach((task, taskId) => {
                if (taskId.startsWith(from)) {
                    activeAutoReplies.delete(taskId);
                    stopped++;
                }
            });
            
            if (stopped > 0) {
                await sendMessage(from, `*RISH ⟁* all stopped | ${stopped} attack(s)`);
            }
        }
    } catch (err) {
        console.error(`[${SESSION_ID}] executeCommand error:`, err.message);
    }
}

async function handleMessage({ messages, type }) {
    try {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message) return;
        
        const messageType = Object.keys(msg.message)[0];
        if (messageType === 'protocolMessage' || messageType === 'senderKeyDistributionMessage') return;
        
        let msgText = msg.message.conversation || 
                      msg.message.extendedTextMessage?.text || 
                      msg.message.imageMessage?.caption || '';
        const isCommand = msgText.trim().startsWith('+') || msgText.trim().startsWith('-');
        
        if (msg.key.fromMe && !isCommand) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        
        let sender;
        if (msg.key.fromMe) {
            sender = botNumber || OWNER_JID;
        } else if (isGroup) {
            sender = msg.key.participant;
        } else {
            sender = from;
        }
        
        if (sender.endsWith('@lid') && sock) {
            try {
                const contactInfo = await sock.onWhatsApp(sender.split('@')[0]).catch(() => null);
                if (contactInfo && contactInfo[0]?.jid) {
                    registerLidMapping(sender, contactInfo[0].jid);
                }
            } catch (e) {}
        }
        
        activeSlides.forEach((task, taskId) => {
            if (task.active && task.groupJid === from && task.targetJid === sender) {
                task.latestMsg = msg;
                task.hasNewMsg = true;
            }
        });
        
        for (const [taskId, task] of activeAutoReplies.entries()) {
            if (task.chatJid === from && task.active) {
                const senderPhone = resolveToPhoneNumber(sender);
                const targetPhone = resolveToPhoneNumber(task.targetJid);
                
                if (sender === task.targetJid || 
                    (senderPhone && targetPhone && senderPhone === targetPhone)) {
                    try {
                        const quotedMsg = {
                            key: {
                                remoteJid: from,
                                fromMe: false,
                                id: msg.key.id,
                                participant: msg.key.participant || sender
                            },
                            message: msg.message
                        };
                        await sock.sendMessage(from, { text: task.replyText }, { quoted: quotedMsg });
                    } catch (err) {
                        console.error(`[${SESSION_ID}] Auto-reply error:`, err.message);
                    }
                    break;
                }
            }
        }
        
        let text = msg.message.conversation || 
                  msg.message.extendedTextMessage?.text || 
                  msg.message.imageMessage?.caption || '';

        const originalText = text;
        text = text.trim().toLowerCase();

        console.log(`[${SESSION_ID}] MSG from ${sender}: ${text}`);

        const isDM = !isGroup;
        
        if (isDM && text === '+ownerme') {
            if (sender.endsWith('@lid')) {
                registerLidMapping(sender, OWNER_JID);
                lidToPhoneMap[sender] = OWNER_NUMBER;
                saveLidMap();
                await sendMessage(from, `*RISH ⟁* LID registered | ${sender} -> ${OWNER_NUMBER}\nSend *+admin* to continue`);
            } else {
                await sendMessage(from, `*RISH ⟁* JID verified: ${sender}`);
            }
            return;
        }
        
        const senderIsOwner = isOwner(sender);
        const senderIsAdmin = isAdmin(sender);
        const senderIsGlobalSubAdmin = isGlobalSubAdmin(sender);
        const senderIsSubAdmin = isGroup ? isSubAdmin(sender, from) : false;
        const senderHasPermission = senderIsAdmin || senderIsGlobalSubAdmin || senderIsSubAdmin;

        if (isDM && text === '+admin') {
            if (senderIsOwner) {
                if (!senderIsAdmin) {
                    addAdmin(sender);
                }
                await sendMessage(from, `*RISH ⟁* Owner verified | +menu for commands`);
            } else if (roles.admins.length <= 1) {
                addAdmin(sender);
                await sendMessage(from, `*RISH ⟁* Admin added | +menu for commands`);
                console.log(`[${SESSION_ID}] New admin:`, sender);
            } else if (senderIsAdmin) {
                await sendMessage(from, `⚠️ You are already an admin! - ${SESSION_ID}`);
            } else {
                await sendMessage(from, `❌ Only the owner can add more admins! - ${SESSION_ID}`);
            }
            return;
        }

        if (isDM && text === '-admin') {
            if (senderIsOwner) {
                await sendMessage(from, `❌ Owner cannot be removed as admin! - ${SESSION_ID}`);
            } else if (senderIsAdmin) {
                removeAdmin(sender);
                await sendMessage(from, `✅ You are no longer an admin! - ${SESSION_ID}`);
                console.log(`[${SESSION_ID}] Removed admin:`, sender);
            } else {
                await sendMessage(from, `⚠️ You are not an admin! - ${SESSION_ID}`);
            }
            return;
        }

        if (originalText.toLowerCase().startsWith('+addsub ')) {
            if (!senderIsAdmin) {
                await sendMessage(from, `❌ Only admins can add global sub-admins - ${SESSION_ID}`);
                return;
            }
            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            
            if (mentionedJids.length === 0) {
                await sendMessage(from, `❌ Mention someone to make them a global sub-admin! - ${SESSION_ID}\n\nUsage: +addsub @user`);
                return;
            }

            let added = [];
            let alreadyExists = [];

            for (const targetJid of mentionedJids) {
                if (addGlobalSubAdmin(targetJid)) {
                    added.push(targetJid);
                } else {
                    alreadyExists.push(targetJid);
                }
            }

            let response = '';
            if (added.length > 0) {
                const mentions = added.map(jid => `@${jid.split('@')[0]}`).join(', ');
                response += `✅ ${mentions} is now a GLOBAL SUB-ADMIN! - ${SESSION_ID}\n`;
                response += `They can use all commands except admin management.\n`;
            }
            if (alreadyExists.length > 0) {
                const mentions = alreadyExists.map(jid => `@${jid.split('@')[0]}`).join(', ');
                response += `⚠️ ${mentions} is already a sub-admin!`;
            }

            await sendMessage(from, response, [...added, ...alreadyExists]);
            return;
        }

        if (originalText.toLowerCase().startsWith('-remsub ')) {
            if (!senderIsAdmin) {
                await sendMessage(from, `❌ Only admins can remove global sub-admins - ${SESSION_ID}`);
                return;
            }
            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            
            if (mentionedJids.length === 0) {
                await sendMessage(from, `❌ Mention someone to remove them as global sub-admin! - ${SESSION_ID}\n\nUsage: -remsub @user`);
                return;
            }

            let removed = [];
            let notFound = [];

            for (const targetJid of mentionedJids) {
                if (removeGlobalSubAdmin(targetJid)) {
                    removed.push(targetJid);
                } else {
                    notFound.push(targetJid);
                }
            }

            let response = '';
            if (removed.length > 0) {
                const mentions = removed.map(jid => `@${jid.split('@')[0]}`).join(', ');
                response += `✅ ${mentions} is no longer a global sub-admin! - ${SESSION_ID}\n`;
            }
            if (notFound.length > 0) {
                const mentions = notFound.map(jid => `@${jid.split('@')[0]}`).join(', ');
                response += `⚠️ ${mentions} was not a sub-admin!`;
            }

            await sendMessage(from, response, [...removed, ...notFound]);
            return;
        }

        if (isGroup && text === '+sub') {
            if (!senderIsAdmin) {
                await sendMessage(from, `❌ Only admins can add sub-admins - ${SESSION_ID}`);
                return;
            }
            if (!msg.message.extendedTextMessage?.contextInfo?.participant) {
                await sendMessage(from, `❌ Reply to someone to make them sub-admin! - ${SESSION_ID}`);
                return;
            }
            const targetJid = msg.message.extendedTextMessage.contextInfo.participant;
            if (addSubAdmin(targetJid, from)) {
                await sendMessage(from, `✅ @${targetJid.split('@')[0]} is now a SUB-ADMIN for this group! - ${SESSION_ID}`, [targetJid]);
            } else {
                await sendMessage(from, `⚠️ Already a sub-admin! - ${SESSION_ID}`);
            }
            return;
        }

        if (isGroup && text === '-sub') {
            if (!senderIsAdmin) {
                await sendMessage(from, `❌ Only admins can remove sub-admins - ${SESSION_ID}`);
                return;
            }
            if (!msg.message.extendedTextMessage?.contextInfo?.participant) {
                await sendMessage(from, `❌ Reply to someone to remove them as sub-admin! - ${SESSION_ID}`);
                return;
            }
            const targetJid = msg.message.extendedTextMessage.contextInfo.participant;
            if (removeSubAdmin(targetJid, from)) {
                await sendMessage(from, `✅ @${targetJid.split('@')[0]} is no longer a sub-admin! - ${SESSION_ID}`, [targetJid]);
            } else {
                await sendMessage(from, `⚠️ Not a sub-admin! - ${SESSION_ID}`);
            }
            return;
        }

        if (text === '+ping' && senderHasPermission) {
            const startTime = Date.now();
            await sendMessage(from, '🏓 Pinging...');
            const latency = Date.now() - startTime;
            await sendMessage(from, `*RISH ⟁* ping: ${latency}ms`);
            return;
        }

        if (text.startsWith('+ai ') && senderHasPermission) {
            const question = text.slice(4).trim();
            if (!question) {
                await sendMessage(from, `❌ Please provide a question!\nUsage: +ai [question]`);
                return;
            }
            await sendMessage(from, `🤖 *RISH ⟁ AI* thinking...`);
            const aiResponse = await askGemini(question);
            await sendMessage(from, `🤖 *RISH ⟁ AI*\n\n${aiResponse}`);
            return;
        }

        if (!senderHasPermission) return;

        if (text === '+menu') {
            await sendMessage(from, `${gouravMenu}\n\n📍 Responding from: ${SESSION_ID}`);
            return;
        }

        if (text === '+status') {
            let localName = 0, localSlide = 0, localTxt = 0, localTTS = 0, localPic = 0;
            
            activeNameChanges.forEach((val, key) => {
                if (key.startsWith(from)) localName++;
            });
            activeSlides.forEach((task) => {
                if (task.groupJid === from && task.active) localSlide++;
            });
            activeTxtSenders.forEach((task, key) => {
                if (key.startsWith(from) && task.active) localTxt++;
            });
            activeTTSSenders.forEach((task, key) => {
                if (key.startsWith(from) && task.active) localTTS++;
            });
            activePicSenders.forEach((task, key) => {
                if (key.startsWith(from) && task.active) localPic++;
            });
            
            const statusMsg = `
*RISH ⟁ STATUS*
━━━━━━━━━━━━━━━━━━━━━
📊 *THIS CHAT*
━━━━━━━━━━━━━━━━━━━━━
⚔️ NC Attacks: ${localName}
🎯 Slide Attacks: ${localSlide}
💀 Text Attacks: ${localTxt}
🎤 TTS Attacks: ${localTTS}
📸 Pic Attacks: ${localPic}
━━━━━━━━━━━━━━━━━━━━━
🤖 Session: ${SESSION_ID}
✅ Status: ${connected ? 'Connected' : 'Disconnected'}
━━━━━━━━━━━━━━━━━━━━━`;
            
            await sendMessage(from, statusMsg);
            return;
        }

        if (text === '-all') {
            await executeCommand('stop_all', { from });
            return;
        }

        for (const ncKey of ['nc1', 'nc2', 'nc3', 'nc4', 'nc5', 'nc6', 'nc7', 'nc8']) {
            if (originalText.toLowerCase().startsWith(`+delaync${ncKey.substring(2)} `)) {
                const delayValue = parseInt(originalText.split(' ')[1]);
                if (isNaN(delayValue) || delayValue < 50) {
                    await sendMessage(from, `❌ Delay must be >= 50ms - ${SESSION_ID}`);
                    return;
                }
                ncDelays[ncKey] = delayValue;
                saveDelays(ncDelays);
                await sendMessage(from, `*RISH ⟁* ${ncKey.toUpperCase()} delay: ${delayValue}ms`);
                return;
            }

            if (originalText.toLowerCase().startsWith(`+${ncKey} `)) {
                const nameText = originalText.slice(ncKey.length + 2).trim();
                if (!nameText) {
                    await sendMessage(from, `❌ Usage: +${ncKey} [text] - ${SESSION_ID}\nExample: +${ncKey} RAID`);
                    return;
                }

                if (!isGroup) {
                    await sendMessage(from, `❌ Use this in a group! - ${SESSION_ID}`);
                    return;
                }

                await executeCommand('start_nc', { from, nameText, ncKey });
                return;
            }
        }

        if (text === '-nc') {
            if (!isGroup) {
                await sendMessage(from, `❌ Use this in a group! - ${SESSION_ID}`);
                return;
            }

            await executeCommand('stop_nc', { from });
            return;
        }

        if (originalText.toLowerCase().startsWith('+s ')) {
            if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                await sendMessage(from, `❌ Reply to target's message! - ${SESSION_ID}\nUsage: +s [text] [delay]`);
                return;
            }

            const args = originalText.slice(3).trim().split(' ');
            if (args.length < 2) {
                await sendMessage(from, `❌ Usage: +s [text] [delay] - ${SESSION_ID}\nExample: +s Hello 1000`);
                return;
            }

            const slideDelay = parseInt(args[args.length - 1]);
            const slideText = args.slice(0, -1).join(' ');

            if (isNaN(slideDelay) || slideDelay < 100) {
                await sendMessage(from, `❌ Delay must be >= 100ms - ${SESSION_ID}`);
                return;
            }

            const quotedParticipant = msg.message.extendedTextMessage.contextInfo.participant || 
                                    msg.message.extendedTextMessage.contextInfo.remoteJid;
            const quotedMsgId = msg.message.extendedTextMessage.contextInfo.stanzaId;
            const quotedMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage;

            await executeCommand('start_slide', {
                from,
                slideText,
                slideDelay,
                quotedParticipant,
                quotedMsgId,
                quotedMessage
            });
            return;
        }

        if (text === '-s') {
            await executeCommand('stop_slide', { from });
            return;
        }

        if (originalText.toLowerCase().startsWith('+txt ')) {
            const args = originalText.slice(5).trim().split(' ');
            if (args.length < 2) {
                await sendMessage(from, `❌ Usage: +txt [text] [delay] - ${SESSION_ID}\nExample: +txt Hello 1000`);
                return;
            }

            const txtDelay = parseInt(args[args.length - 1]);
            const txtText = args.slice(0, -1).join(' ');

            if (isNaN(txtDelay) || txtDelay < 100) {
                await sendMessage(from, `❌ Delay must be >= 100ms - ${SESSION_ID}`);
                return;
            }

            await executeCommand('start_txt', { from, txtText, txtDelay });
            return;
        }

        if (text === '-txt') {
            await executeCommand('stop_txt', { from });
            return;
        }

        if (originalText.toLowerCase().startsWith('+ttsify ')) {
            const songQuery = originalText.slice(8).trim();
            if (!songQuery) {
                await sendMessage(from, `❌ Usage: +ttsify [song name or spotify url] - ${SESSION_ID}\nExample: +ttsify Shape of You`);
                return;
            }

            await sendMessage(from, `🎵 Searching: ${songQuery}...`);

            try {
                const result = await downloadSpotifyAsVoiceNote(songQuery);
                await sock.sendMessage(from, {
                    audio: result.buffer,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true
                });
                await sendMessage(from, `🎶 ${result.trackName} - ${result.artistName}`);
            } catch (err) {
                console.error(`[${SESSION_ID}] Spotify error:`, err.message);
                await sendMessage(from, `❌ Could not find/download: ${songQuery}`);
            }
            return;
        }

        if (originalText.toLowerCase().startsWith('+tts ')) {
            const ttsText = originalText.slice(5).trim();
            if (!ttsText) {
                await sendMessage(from, `❌ Usage: +tts [text] - ${SESSION_ID}\nExample: +tts Hello everyone`);
                return;
            }

            try {
                const audioBuffer = await generateTTS(ttsText);
                await sock.sendMessage(from, {
                    audio: audioBuffer,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true
                });
            } catch (err) {
                console.error(`[${SESSION_ID}] TTS error:`, err.message);
                await sendMessage(from, `❌ TTS error - ${SESSION_ID}`);
            }
            return;
        }

        if (originalText.toLowerCase().startsWith('+ttsatk ')) {
            const args = originalText.slice(8).trim().split(' ');
            if (args.length < 2) {
                await sendMessage(from, `❌ Usage: +ttsatk [text] [delay] - ${SESSION_ID}\nExample: +ttsatk Hello 2000`);
                return;
            }

            const ttsDelay = parseInt(args[args.length - 1]);
            const ttsText = args.slice(0, -1).join(' ');

            if (isNaN(ttsDelay) || ttsDelay < 1000) {
                await sendMessage(from, `❌ Delay must be >= 1000ms (1s) - ${SESSION_ID}`);
                return;
            }

            await executeCommand('start_tts', { from, ttsText, ttsDelay });
            return;
        }

        if (text === '-ttsatk') {
            await executeCommand('stop_tts', { from });
            return;
        }

        if (originalText.toLowerCase().startsWith('+pic ')) {
            if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                await sendMessage(from, `❌ Reply to an image! - ${SESSION_ID}\nUsage: +pic [delay]`);
                return;
            }

            const picDelay = parseInt(originalText.slice(5).trim());
            if (isNaN(picDelay) || picDelay < 100) {
                await sendMessage(from, `❌ Delay must be >= 100ms - ${SESSION_ID}`);
                return;
            }

            const quotedMsg = {
                key: {
                    remoteJid: from,
                    fromMe: false,
                    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                    participant: msg.message.extendedTextMessage.contextInfo.participant
                },
                message: msg.message.extendedTextMessage.contextInfo.quotedMessage
            };

            try {
                const imageBuffer = await downloadMediaMessage(quotedMsg, 'buffer', {});
                const imageMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
                
                await executeCommand('start_pic', { 
                    from, 
                    picDelay, 
                    imageBuffer: imageBuffer.toString('base64'),
                    mimetype: imageMessage.mimetype || 'image/jpeg'
                });
            } catch (err) {
                console.error(`[${SESSION_ID}] Error downloading image:`, err.message);
                await sendMessage(from, `❌ Error downloading image - ${SESSION_ID}`);
            }
            return;
        }

        if (text === '-pic') {
            await executeCommand('stop_pic', { from });
            return;
        }

        if (originalText.toLowerCase().startsWith('+reply ')) {
            if (!msg.message.extendedTextMessage?.contextInfo?.participant) {
                await sendMessage(from, `❌ Reply to a message! - ${SESSION_ID}\nUsage: +reply [text]`);
                return;
            }

            const replyText = originalText.slice(7).trim();
            if (!replyText) {
                await sendMessage(from, `❌ Provide reply text! - ${SESSION_ID}\nUsage: +reply [text]`);
                return;
            }

            const quotedParticipant = msg.message.extendedTextMessage.contextInfo.participant;
            await executeCommand('start_reply', { from, replyText, targetJid: quotedParticipant });
            return;
        }

        if (text === '-reply') {
            await executeCommand('stop_reply', { from });
            return;
        }

    } catch (err) {
        console.error(`[${SESSION_ID}] ERROR:`, err);
    }
}

async function connectToWhatsApp() {
    try {
        if (!fs.existsSync(AUTH_PATH)) {
            fs.mkdirSync(AUTH_PATH, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
        const { version } = await fetchLatestBaileysVersion();
        
        const needsPairing = !state.creds.registered;

        sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            logger: pino({ level: 'silent' }),
            browser: BROWSER_CONFIG,
            version,
            printQRInTerminal: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: true,
            fireInitQueries: true,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            getMessage
        });
        
        bindStoreToSocket(sock);

        let pairingCodeRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if ((connection === 'connecting' || qr) && needsPairing && !pairingCodeRequested && !state.creds.registered) {
                pairingCodeRequested = true;
                await delay(2000);
                
                const credsPath = `${AUTH_PATH}/creds.json`;
                let phoneNumber = null;
                
                if (fs.existsSync(credsPath)) {
                    try {
                        const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                        if (credsData.me?.id) {
                            phoneNumber = credsData.me.id.split(':')[0];
                        }
                    } catch (e) {}
                }
                
                if (!phoneNumber) {
                    console.log(`\n[${SESSION_ID}] No credentials found. Please enter the phone number for this session.`);
                    console.log(`[${SESSION_ID}] Or create the session folder with credentials first.\n`);
                    
                    const readline = await import('readline');
                    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                    const question = (text) => new Promise((resolve) => rl.question(text, resolve));
                    
                    phoneNumber = await question(`Enter phone number for ${SESSION_ID} (e.g. 919876543210): `);
                    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
                    rl.close();
                    
                    if (!phoneNumber || phoneNumber.length < 10) {
                        console.log(`[${SESSION_ID}] Invalid phone number. Exiting...`);
                        process.exit(1);
                    }
                }
                
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n╔══════════════════════════════════════╗`);
                    console.log(`║   ${SESSION_ID} PAIRING CODE          ║`);
                    console.log(`╠══════════════════════════════════════╣`);
                    console.log(`║          ${code}                  ║`);
                    console.log(`╠══════════════════════════════════════╣`);
                    console.log(`║  Go to WhatsApp > Linked Devices     ║`);
                    console.log(`║  > Link a Device > Link with         ║`);
                    console.log(`║  phone number instead                ║`);
                    console.log(`╚══════════════════════════════════════╝\n`);
                } catch (err) {
                    console.error(`[${SESSION_ID}] Error getting pairing code:`, err.message);
                    pairingCodeRequested = false;
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : 500;

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`[${SESSION_ID}] Connection closed. Status: ${statusCode}`);
                connected = false;

                if (shouldReconnect) {
                    console.log(`[${SESSION_ID}] Reconnecting in 5 seconds...`);
                    await delay(5000);
                    connectToWhatsApp();
                } else {
                    console.log(`[${SESSION_ID}] Logged out. Exiting...`);
                    process.exit(0);
                }
            } else if (connection === 'open') {
                console.log(`[${SESSION_ID}] ✅ CONNECTED!`);
                connected = true;
                botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                console.log(`[${SESSION_ID}] Number: ${botNumber}`);
            }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', async (m) => handleMessage(m));

    } catch (err) {
        console.error(`[${SESSION_ID}] Connection error:`, err.message);
        console.log(`[${SESSION_ID}] Retrying in 5 seconds...`);
        await delay(5000);
        connectToWhatsApp();
    }
}

console.log('╔══════════════════════════════════════╗');
console.log(`║      RISH ⟁ BOT - ${SESSION_ID}       ║`);
console.log('║      Powered by Baileys v2.0         ║');
console.log('╚══════════════════════════════════════╝\n');
console.log(`👑 Owner: ${OWNER_JID.split('@')[0]}`);
console.log(`📁 Auth Path: ${AUTH_PATH}`);
console.log('');

connectToWhatsApp();

console.log(`\nRish ⟁ Bot ${SESSION_ID} Starting...`);
console.log('📌 Owner is automatically admin');
console.log('📌 Send +menu to see commands\n');

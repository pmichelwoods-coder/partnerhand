// server.js – Vonage with test-number lock (full)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const shortid = require('shortid');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 5001;

// ============================================
// SKIP WHATSAPP – read from environment
// ============================================
const SKIP_WHATSAPP = process.env.SKIP_WHATSAPP === 'false' ? false : true;

// ============================================
// TEST NUMBER LOCK – only this number can receive during testing
// ============================================
const TEST_PHONE_NUMBER = process.env.TEST_PHONE_NUMBER || '18299251967';
const ALLOW_ALL_NUMBERS = process.env.ALLOW_ALL_NUMBERS === 'true' ? true : false;

// ============================================
// VONAGE CONFIG
// ============================================
const VONAGE_API_KEY = process.env.VONAGE_API_KEY;
const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET;
const VONAGE_FROM_NUMBER = process.env.VONAGE_FROM_NUMBER || '14157386102'; // Sandbox

// ============================================
// OLD CONFIG (kept for compatibility)
// ============================================
const PROJECT_NAME = process.env.PROJECT_NAME || 'Conecta Y Gana RD 5 Mil';
const PROJECT_LOGIN = process.env.PROJECT_LOGIN || 'd92kko9jfeec73bck270';

const DB_FILE = path.join(__dirname, 'database.json');

// ============================================
// DATABASE HELPERS
// ============================================
function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        const defaultData = {
            users: [],
            payments: [],
            referrals: [],
            payouts: [],
            pendingApprovals: []
        };
        writeDB(defaultData);
        return defaultData;
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function isCodeUnique(code, db) {
    return !db.users.some(u => u.referralCode === code);
}

// ============================================
// WHATSAPP SENDER (Vonage) with test lock
// ============================================
async function sendWhatsAppMessage(phoneNumber, message) {
    if (SKIP_WHATSAPP) {
        console.log('📨 [SKIP] WhatsApp message to', phoneNumber, ':', message);
        return { success: true, skipped: true };
    }

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    const cleanTest = TEST_PHONE_NUMBER.replace(/[^0-9]/g, '');
    if (!ALLOW_ALL_NUMBERS && cleanPhone !== cleanTest) {
        console.warn(`⛔ Blocked: ${phoneNumber} is not the test number (${TEST_PHONE_NUMBER})`);
        throw new Error('Testing mode: only the test number is allowed.');
    }

    const auth = Buffer.from(`${VONAGE_API_KEY}:${VONAGE_API_SECRET}`).toString('base64');
    const payload = {
        from: VONAGE_FROM_NUMBER,
        to: cleanPhone,
        channel: 'whatsapp',
        message_type: 'text',
        text: message,
    };

    try {
        const response = await fetch('https://messages-sandbox.nexmo.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`,
            },
            body: JSON.stringify(payload),
        });

        const data = await response.json();
        if (!response.ok) {
            console.error('❌ Vonage Error:', data);
            throw new Error(data.title || data.description || 'Vonage send failed');
        }
        console.log(`✅ Sent to ${phoneNumber}`, data);
        return { success: true, result: data };
    } catch (error) {
        console.error('WhatsApp send error:', error);
        throw error;
    }
}

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        service: PROJECT_NAME,
        whatsappProvider: 'Vonage',
        whatsappNumber: VONAGE_FROM_NUMBER,
        testNumberLock: TEST_PHONE_NUMBER,
        allNumbersAllowed: ALLOW_ALL_NUMBERS,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// REGISTER USER
// ============================================
app.post('/api/register', async (req, res) => {
    try {
        const { phone, name, comprobante, refereeCode } = req.body;
        const email = req.body.email || `user_${Date.now()}@temp.com`;

        if (!phone || !name || !comprobante) {
            return res.status(400).json({ error: 'Todos los campos son requeridos' });
        }
        if (!/^\d{8,}$/.test(comprobante)) {
            return res.status(400).json({ error: 'El comprobante debe tener 8 o más dígitos numéricos' });
        }

        const db = readDB();
        if (db.users.some(u => u.phone === phone)) {
            return res.status(400).json({ error: 'Este número ya está registrado' });
        }
        if (db.users.some(u => u.comprobante === comprobante)) {
            return res.status(400).json({ error: 'Este comprobante ya ha sido utilizado' });
        }

        const newUser = {
            id: shortid.generate(),
            phone,
            name,
            email,
            comprobante,
            refereeCode: refereeCode || null,
            status: 'pending',
            referralCode: null,
            createdAt: new Date().toISOString(),
            approvedAt: null,
            expiresAt: null,
            totalCustomers: 0,
            activeCustomers: 0,
            pendingCustomers: 0,
            totalPaid: 0,
            bankingDetails: null,
            deviceId: null
        };

        db.users.push(newUser);
        writeDB(db);

        if (refereeCode) {
            const referee = db.users.find(u => u.referralCode === refereeCode);
            if (referee && referee.status === 'approved') {
                referee.pendingCustomers = (referee.pendingCustomers || 0) + 1;
                writeDB(db);
            }
        }

        await sendWhatsAppMessage(phone,
            `📋 Hola ${name}, hemos recibido tu depósito de RD 1,250.\n\n` +
            `🔍 Tu comprobante #${comprobante} está en revisión.\n` +
            `⏰ El proceso puede tomar hasta 48 horas.\n\n` +
            `📲 Te notificaremos cuando sea aprobado.\n\n` +
            `"Tú ayudas, otros crecen, todos ganamos."`
        );

        if (refereeCode) {
            const referee = db.users.find(u => u.referralCode === refereeCode);
            if (referee && referee.status === 'approved') {
                await sendWhatsAppMessage(referee.phone,
                    `👤 Hola ${referee.name}, ¡tienes un nuevo cliente pendiente!\n\n` +
                    `📱 ${name} se ha registrado usando tu enlace.\n` +
                    `📋 Comprobante #${comprobante} en revisión.\n` +
                    `⏰ Espera 48 horas para la confirmación.\n\n` +
                    `📲 Te notificaremos cuando sea aprobado.`
                );
            }
        }

        res.json({
            success: true,
            message: 'Depósito recibido. Está en revisión (48 horas).',
            userId: newUser.id,
            status: 'pending'
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Error al registrar usuario: ' + error.message });
    }
});

// ============================================
// ADMIN: APPROVE/REJECT PAYMENT
// ============================================
app.post('/api/admin/approve-payment', async (req, res) => {
    try {
        const { userId, action } = req.body;
        const db = readDB();
        const userIndex = db.users.findIndex(u => u.id === userId);
        if (userIndex === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        const user = db.users[userIndex];

        if (action === 'approve') {
            let referralCode;
            do {
                referralCode = generateReferralCode();
            } while (!isCodeUnique(referralCode, db));

            user.status = 'approved';
            user.referralCode = referralCode;
            user.approvedAt = new Date().toISOString();

            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + 90);
            user.expiresAt = expiryDate.toISOString();

            if (user.refereeCode) {
                const referee = db.users.find(u => u.referralCode === user.refereeCode);
                if (referee && referee.status === 'approved') {
                    referee.pendingCustomers = Math.max((referee.pendingCustomers || 0) - 1, 0);
                }
            }

            writeDB(db);

            await sendWhatsAppMessage(user.phone,
                `🎉 ¡FELICITACIONES ${user.name}! Tu depósito ha sido APROBADO.\n\n` +
                `✅ Tu cuenta está activa por 90 días.\n` +
                `🔑 Tu código de referido es: *${referralCode}*\n\n` +
                `📱 Comparte tu enlace:\n` +
                `https://conectaygana.onrender.com/?ref=${referralCode}\n\n` +
                `💰 Gana RD 5,000 por cada 5 clientes.\n` +
                `📌 No hay límite para ganar.\n\n` +
                `"Tú ayudas, otros crecen, todos ganamos."`
            );

            if (user.refereeCode) {
                const referee = db.users.find(u => u.referralCode === user.refereeCode);
                if (referee && referee.status === 'approved') {
                    referee.totalCustomers += 1;
                    referee.activeCustomers += 1;
                    writeDB(db);

                    await sendWhatsAppMessage(referee.phone,
                        `🎉 Hola ${referee.name}, ¡nuevo cliente APROBADO!\n\n` +
                        `👤 ${user.name} ha sido confirmado.\n` +
                        `📊 Ahora tienes ${referee.totalCustomers} clientes totales.\n` +
                        `💰 ${referee.activeCustomers} clientes activos.\n\n` +
                        `🏆 Gana RD 5,000 al llegar a 5 clientes.`
                    );

                    if (referee.activeCustomers > 0 && referee.activeCustomers % 5 === 0) {
                        const milestone = Math.floor(referee.activeCustomers / 5);
                        const existingPayout = db.payouts.find(p =>
                            p.refereePhone === referee.phone &&
                            p.milestone === milestone &&
                            p.status === 'pending'
                        );
                        if (!existingPayout) {
                            const newPayout = {
                                id: shortid.generate(),
                                refereePhone: referee.phone,
                                refereeName: referee.name,
                                milestone: milestone,
                                amount: 5000,
                                status: 'pending',
                                createdAt: new Date().toISOString(),
                                completedAt: null,
                                transactionNumber: null,
                                transactionDate: null,
                                adminNotes: null
                            };
                            db.payouts.push(newPayout);
                            writeDB(db);

                            await sendWhatsAppMessage(referee.phone,
                                `💰 Hola ${referee.name}, ¡FELICITACIONES! Has alcanzado ${referee.activeCustomers} clientes.\n\n` +
                                `💵 Tienes un pago pendiente de RD 5,000.\n` +
                                `⏰ El administrador procesará tu pago en 2 días hábiles.\n\n` +
                                `🏆 Sigue compartiendo para ganar más.`
                            );
                        }
                    }
                }
            }

        } else if (action === 'reject') {
            user.status = 'rejected';
            writeDB(db);

            await sendWhatsAppMessage(user.phone,
                `❌ Hola ${user.name}, tu depósito ha sido RECHAZADO.\n\n` +
                `📋 Comprobante #${user.comprobante} no fue aprobado.\n` +
                `📌 Motivo: El comprobante no coincide con nuestros registros.\n\n` +
                `🔄 Puedes intentar nuevamente con un nuevo comprobante.`
            );
        }

        res.json({
            success: true,
            message: `Pago ${action === 'approve' ? 'aprobado' : 'rechazado'} exitosamente`,
            userStatus: user.status
        });

    } catch (error) {
        console.error('Admin approval error:', error);
        res.status(500).json({ error: 'Error al procesar la aprobación' });
    }
});

// ============================================
// USER DASHBOARD
// ============================================
app.get('/api/user/:phone', (req, res) => {
    try {
        const { phone } = req.params;
        const db = readDB();
        const user = db.users.find(u => u.phone === phone);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

        res.json({
            name: user.name,
            phone: user.phone,
            status: user.status,
            referralCode: user.referralCode,
            totalCustomers: user.totalCustomers || 0,
            activeCustomers: user.activeCustomers || 0,
            pendingCustomers: user.pendingCustomers || 0,
            totalPaid: user.totalPaid || 0,
            expiresAt: user.expiresAt,
            createdAt: user.createdAt,
            bankingDetails: user.bankingDetails || null,
            daysRemaining: user.expiresAt ?
                Math.ceil((new Date(user.expiresAt) - new Date()) / (1000 * 60 * 60 * 24)) : null
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Error al obtener datos del usuario' });
    }
});

// ============================================
// GET REFERRED USERS
// ============================================
app.get('/api/user/:phone/referrals', (req, res) => {
    try {
        const { phone } = req.params;
        const db = readDB();
        const referee = db.users.find(u => u.phone === phone);
        if (!referee) return res.status(404).json({ error: 'Usuario no encontrado' });

        const referrals = db.users.filter(u =>
            u.refereeCode === referee.referralCode && u.phone !== phone
        );
        const referralList = referrals.map(u => ({
            name: u.name,
            phone: u.phone,
            status: u.status,
            createdAt: u.createdAt,
            comprobante: u.comprobante
        }));

        res.json({ count: referralList.length, referrals: referralList });
    } catch (error) {
        console.error('Referrals error:', error);
        res.status(500).json({ error: 'Error al obtener referidos' });
    }
});

// ============================================
// GET PAYOUT STATS
// ============================================
app.get('/api/user/:phone/payouts', (req, res) => {
    try {
        const { phone } = req.params;
        const db = readDB();
        const user = db.users.find(u => u.phone === phone);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

        const userPayouts = db.payouts.filter(p => p.refereePhone === phone);
        const totalPaid = userPayouts
            .filter(p => p.status === 'completed')
            .reduce((sum, p) => sum + p.amount, 0);

        const nextMilestone = Math.floor((user.activeCustomers || 0) / 5);
        const paidMilestones = userPayouts
            .filter(p => p.status === 'completed')
            .map(p => p.milestone);

        const pendingMilestones = [];
        for (let i = 1; i <= nextMilestone; i++) {
            if (!paidMilestones.includes(i)) pendingMilestones.push(i);
        }

        res.json({
            totalPaid,
            payouts: userPayouts,
            pendingMilestones,
            nextPayoutAmount: pendingMilestones.length > 0 ? 5000 * pendingMilestones.length : 0
        });
    } catch (error) {
        console.error('Payout stats error:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas de pago' });
    }
});

// ============================================
// ADMIN: CREATE PAYOUT
// ============================================
app.post('/api/admin/create-payout', async (req, res) => {
    try {
        const { refereePhone, milestone } = req.body;
        const db = readDB();
        const referee = db.users.find(u => u.phone === refereePhone);
        if (!referee) return res.status(404).json({ error: 'Referido no encontrado' });

        const existing = db.payouts.find(p =>
            p.refereePhone === refereePhone && p.milestone === milestone && p.status === 'pending'
        );
        if (existing) return res.status(400).json({ error: 'Ya existe un pago pendiente para este hito' });

        const newPayout = {
            id: shortid.generate(),
            refereePhone,
            refereeName: referee.name,
            milestone,
            amount: 5000,
            status: 'pending',
            createdAt: new Date().toISOString(),
            completedAt: null,
            transactionNumber: null,
            transactionDate: null,
            adminNotes: null
        };
        db.payouts.push(newPayout);
        writeDB(db);

        res.json({ success: true, message: 'Pago creado exitosamente', payout: newPayout });
    } catch (error) {
        console.error('Create payout error:', error);
        res.status(500).json({ error: 'Error al crear el pago' });
    }
});

// ============================================
// ADMIN: COMPLETE PAYOUT
// ============================================
app.post('/api/admin/complete-payout', async (req, res) => {
    try {
        const { payoutId, transactionNumber, transactionDate } = req.body;
        if (!payoutId || !transactionNumber || !transactionDate) {
            return res.status(400).json({ error: 'Todos los campos son requeridos' });
        }

        const db = readDB();
        const payoutIndex = db.payouts.findIndex(p => p.id === payoutId);
        if (payoutIndex === -1) return res.status(404).json({ error: 'Pago no encontrado' });

        const payout = db.payouts[payoutIndex];
        payout.status = 'completed';
        payout.completedAt = new Date().toISOString();
        payout.transactionNumber = transactionNumber;
        payout.transactionDate = transactionDate;

        const referee = db.users.find(u => u.phone === payout.refereePhone);
        if (referee) referee.totalPaid = (referee.totalPaid || 0) + payout.amount;

        writeDB(db);

        await sendWhatsAppMessage(payout.refereePhone,
            `💰 ¡FELICITACIONES ${referee ? referee.name : ''}! Tu pago ha sido COMPLETADO.\n\n` +
            `💵 Monto: RD ${payout.amount.toLocaleString()}\n` +
            `📋 Transacción: ${transactionNumber}\n` +
            `📅 Fecha: ${new Date(transactionDate).toLocaleDateString()}\n\n` +
            `✅ Has alcanzado ${payout.milestone * 5} clientes.\n` +
            `🏆 Sigue compartiendo para ganar más.\n\n` +
            `"Tú ayudas, otros crecen, todos ganamos."`
        );

        res.json({ success: true, message: 'Pago completado exitosamente', payout });
    } catch (error) {
        console.error('Complete payout error:', error);
        res.status(500).json({ error: 'Error al completar el pago' });
    }
});

// ============================================
// ADMIN: PENDING PAYOUTS
// ============================================
app.get('/api/admin/pending-payouts', (req, res) => {
    try {
        const db = readDB();
        const pending = db.payouts.filter(p => p.status === 'pending');
        res.json({ count: pending.length, payouts: pending });
    } catch (error) {
        console.error('Pending payouts error:', error);
        res.status(500).json({ error: 'Error al obtener pagos pendientes' });
    }
});

// ============================================
// UPDATE BANKING DETAILS
// ============================================
app.post('/api/user/update-banking', async (req, res) => {
    try {
        const { phone, bankName, accountNumber, accountType } = req.body;
        if (!phone || !bankName || !accountNumber || !accountType) {
            return res.status(400).json({ error: 'Todos los campos bancarios son requeridos' });
        }

        const db = readDB();
        const user = db.users.find(u => u.phone === phone);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

        user.bankingDetails = { bankName, accountNumber, accountType, updatedAt: new Date().toISOString() };
        writeDB(db);

        res.json({ success: true, message: 'Datos bancarios actualizados correctamente' });
    } catch (error) {
        console.error('Banking update error:', error);
        res.status(500).json({ error: 'Error al actualizar datos bancarios' });
    }
});

// ============================================
// ADMIN: PENDING APPROVALS
// ============================================
app.get('/api/admin/pending', (req, res) => {
    try {
        const db = readDB();
        const pending = db.users.filter(u => u.status === 'pending');
        res.json({ count: pending.length, users: pending });
    } catch (error) {
        console.error('Pending approvals error:', error);
        res.status(500).json({ error: 'Error al obtener aprobaciones pendientes', details: error.message });
    }
});

// ============================================
// ADMIN: ALL USERS
// ============================================
app.get('/api/admin/users', (req, res) => {
    try {
        const db = readDB();
        res.json({ total: db.users.length, users: db.users });
    } catch (error) {
        console.error('Users list error:', error);
        res.status(500).json({ error: 'Error al obtener lista de usuarios', details: error.message });
    }
});

// ============================================
// EXPIRY CHECK (runs every 6 hours)
// ============================================
async function checkExpiringUsers() {
    const db = readDB();
    const now = new Date();

    for (const user of db.users) {
        if (user.status !== 'approved' || !user.expiresAt) continue;
        const expiryDate = new Date(user.expiresAt);
        const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

        if (daysRemaining === 1) {
            await sendWhatsAppMessage(user.phone,
                `⚠️ Hola ${user.name}, ¡ATENCIÓN! Tu cuenta expira mañana.\n\n` +
                `📅 Fecha de expiración: ${expiryDate.toLocaleDateString()}\n` +
                `📊 Tienes ${user.activeCustomers} clientes activos.\n\n` +
                `🔄 Si tienes 3+ clientes en el sistema,\n` +
                `contacta al administrador para reactivación.\n\n` +
                `📌 De lo contrario, perderás tus referidos.`
            );
        }

        if (daysRemaining <= 3 && user.pendingCustomers >= 3) {
            console.log(`⚠️ User ${user.phone} (${user.name}) has ${user.pendingCustomers} pending clients and expires in ${daysRemaining} days`);
        }
    }
}

setInterval(checkExpiringUsers, 6 * 60 * 60 * 1000);

// ============================================
// STATIC PAGES
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// ============================================
// TEST ENDPOINT (for manual testing)
// ============================================
app.post('/test-send', async (req, res) => {
    const { to, text } = req.body;
    if (!to || !text) {
        return res.status(400).json({ error: 'Missing "to" or "text"' });
    }
    try {
        const result = await sendWhatsAppMessage(to, text);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// WEBHOOK ENDPOINTS (for receiving messages and status updates)
// ============================================
app.post('/webhook/vonage/inbound', (req, res) => {
    console.log('📩 Incoming WhatsApp:', req.body);
    res.status(200).send('OK');
});

app.post('/webhook/vonage/status', (req, res) => {
    console.log('📊 Status Update:', req.body);
    res.status(200).send('OK');
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log('========================================');
    console.log(`🚀 ${PROJECT_NAME} API`);
    console.log(`📱 WhatsApp Provider: Vonage (Sandbox)`);
    console.log(`🔑 From Number: ${VONAGE_FROM_NUMBER}`);
    console.log(`🧪 Test Number Lock: ${TEST_PHONE_NUMBER}`);
    console.log(`🔓 All Numbers Allowed: ${ALLOW_ALL_NUMBERS}`);
    console.log('========================================');
    console.log('✅ ALL CREDENTIALS CONFIGURED!');
    console.log('========================================');
    console.log('📋 Available endpoints:');
    console.log(`   • POST /api/register`);
    console.log(`   • POST /api/admin/approve-payment`);
    console.log(`   • GET  /api/user/:phone`);
    console.log(`   • GET  /api/user/:phone/referrals`);
    console.log(`   • GET  /api/user/:phone/payouts`);
    console.log(`   • POST /api/user/update-banking`);
    console.log(`   • GET  /api/admin/pending`);
    console.log(`   • GET  /api/admin/users`);
    console.log(`   • GET  /api/admin/pending-payouts`);
    console.log(`   • POST /api/admin/create-payout`);
    console.log(`   • POST /api/admin/complete-payout`);
    console.log(`   • POST /test-send (testing only)`);
    console.log(`   • POST /webhook/vonage/inbound`);
    console.log(`   • POST /webhook/vonage/status`);
    console.log(`   • GET  / -> signup page`);
    console.log(`   • GET  /dashboard`);
    console.log(`   • GET  /admin`);
    console.log('========================================');
    console.log(`🧪 SKIP_WHATSAPP is ${SKIP_WHATSAPP ? 'ENABLED' : 'DISABLED'}`);
    console.log('========================================');
});

module.exports = app;
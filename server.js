require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const shortid = require('shortid');

const app = express();
const PORT = process.env.PORT || 5001;

// ============================================
// SKIP WHATSAPP FOR LOCAL TESTING
// Set to false when ready to send real messages
// ============================================
const SKIP_WHATSAPP = true; // ← Set to false for real WhatsApp messages

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// CONFIGURATION
// ============================================
const MESSAGGIO_LOGIN = 'a88a79e9de5345ea8985910bf91240fc';
const WHATSAPP_FROM = 'd934r7odajas738cbf30';
const WHATSAPP_NUMBER = '+18292777135'; // ← UPDATED NUMBER
const PROJECT_NAME = 'Conecta Y Gana RD 5 Mil';

// Database file
const DB_FILE = path.join(__dirname, 'database.json');

// ============================================
// DATABASE HELPERS
// ============================================
function readDB() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return { users: [], payments: [], referrals: [], payouts: [], pendingApprovals: [] };
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
// WHATSAPP SENDER (with SKIP option)
// ============================================
async function sendWhatsAppMessage(phoneNumber, message) {
    if (SKIP_WHATSAPP) {
        console.log('📨 [SKIP] WhatsApp message to', phoneNumber, ':', message);
        return { success: true, skipped: true };
    }

    try {
        const cleanPhone = phoneNumber.replace(/\+/g, '');
        const payload = {
            recipients: [{ phone: cleanPhone }],
            channels: ['whatsapp'],
            whatsapp: {
                from: WHATSAPP_FROM,
                content: [{ type: 'text', text: message }]
            }
        };

        const response = await fetch('https://msg.messaggio.com/api/v1/send', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Messaggio-Login': MESSAGGIO_LOGIN
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('WhatsApp send error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        service: PROJECT_NAME,
        whatsappNumber: WHATSAPP_NUMBER,
        messaggioConfigured: true,
        projectLogin: 'd92kko9jfeec73bck270',
        senderCode: WHATSAPP_FROM,
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

        // Validate
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

        // Send WhatsApp to user (deposit received)
        await sendWhatsAppMessage(phone,
            `📋 Hola ${name}, hemos recibido tu depósito de RD 1,250.\n\n` +
            `🔍 Tu comprobante #${comprobante} está en revisión.\n` +
            `⏰ El proceso puede tomar hasta 48 horas.\n\n` +
            `📲 Te notificaremos cuando sea aprobado.\n\n` +
            `"Tú ayudas, otros crecen, todos ganamos."`
        );

        // Notify referee if exists
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
        res.status(500).json({ error: 'Error al registrar usuario' });
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

        if (userIndex === -1) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

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

            await sendWhatsAppMessage(user.phone,
                `🎉 ¡FELICITACIONES ${user.name}! Tu depósito ha sido APROBADO.\n\n` +
                `✅ Tu cuenta está activa por 90 días.\n` +
                `🔑 Tu código de referido es: *${referralCode}*\n\n` +
                `📱 Comparte tu enlace:\n` +
                `https://conectaygana.com/ref/${referralCode}\n\n` +
                `💰 Gana RD 5,000 por cada 5 clientes.\n` +
                `📌 No hay límite para ganar.\n\n` +
                `"Tú ayudas, otros crecen, todos ganamos."`
            );

            if (user.refereeCode) {
                const referee = db.users.find(u => u.referralCode === user.refereeCode);
                if (referee && referee.status === 'approved') {
                    referee.totalCustomers += 1;
                    referee.activeCustomers += 1;

                    await sendWhatsAppMessage(referee.phone,
                        `🎉 Hola ${referee.name}, ¡nuevo cliente APROBADO!\n\n` +
                        `👤 ${user.name} ha sido confirmado.\n` +
                        `📊 Ahora tienes ${referee.totalCustomers} clientes totales.\n` +
                        `💰 ${referee.activeCustomers} clientes activos.\n\n` +
                        `🏆 Gana RD 5,000 al llegar a 5 clientes.`
                    );

                    if (referee.activeCustomers % 5 === 0) {
                        const payoutAmount = 5000 * (referee.activeCustomers / 5);
                        await sendWhatsAppMessage(referee.phone,
                            `💰 Hola ${referee.name}, ¡FELICITACIONES! Has alcanzado ${referee.activeCustomers} clientes.\n\n` +
                            `💵 Ganas RD ${payoutAmount.toLocaleString()}.\n` +
                            `🏦 Por favor, proporciona tus datos bancarios para el pago.\n` +
                            `⏰ El pago se procesará en 2 días hábiles.`
                        );
                    }
                }
            }

        } else if (action === 'reject') {
            user.status = 'rejected';

            await sendWhatsAppMessage(user.phone,
                `❌ Hola ${user.name}, tu depósito ha sido RECHAZADO.\n\n` +
                `📋 Comprobante #${user.comprobante} no fue aprobado.\n` +
                `📌 Motivo: El comprobante no coincide con nuestros registros.\n\n` +
                `🔄 Puedes intentar nuevamente con un nuevo comprobante.`
            );
        }

        writeDB(db);

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

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const dashboardData = {
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
        };

        res.json(dashboardData);
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Error al obtener datos del usuario' });
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

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        user.bankingDetails = {
            bankName,
            accountNumber,
            accountType,
            updatedAt: new Date().toISOString()
        };

        writeDB(db);

        res.json({
            success: true,
            message: 'Datos bancarios actualizados correctamente'
        });

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

        res.json({
            count: pending.length,
            users: pending
        });
    } catch (error) {
        console.error('Pending approvals error:', error);
        res.status(500).json({ error: 'Error al obtener aprobaciones pendientes' });
    }
});

// ============================================
// ADMIN: ALL USERS
// ============================================
app.get('/api/admin/users', (req, res) => {
    try {
        const db = readDB();
        res.json({
            total: db.users.length,
            users: db.users
        });
    } catch (error) {
        console.error('Users list error:', error);
        res.status(500).json({ error: 'Error al obtener lista de usuarios' });
    }
});

// ============================================
// EXPIRY CHECK
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
// REFERRAL LINK REDIRECT
// ============================================
app.get('/ref/:code', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// SERVE PAGES
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
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log('========================================');
    console.log(`🚀 ${PROJECT_NAME} API`);
    console.log(`📱 WhatsApp: ${WHATSAPP_NUMBER}`);
    console.log(`🔑 Sender Code: ${WHATSAPP_FROM}`);
    console.log(`🔗 Project Login: d92kko9jfeec73bck270`);
    console.log('========================================');
    console.log('✅ ALL CREDENTIALS CONFIGURED!');
    console.log('========================================');
    console.log('📋 Available endpoints:');
    console.log(`   • POST /api/register                  → Register with payment`);
    console.log(`   • POST /api/admin/approve-payment    → Approve/Reject payment`);
    console.log(`   • GET  /api/user/:phone              → User dashboard data`);
    console.log(`   • POST /api/user/update-banking      → Update banking details`);
    console.log(`   • GET  /api/admin/pending            → Get pending approvals`);
    console.log(`   • GET  /api/admin/users              → Get all users`);
    console.log(`   • GET  /                             → Signup page`);
    console.log(`   • GET  /dashboard                    → User dashboard`);
    console.log(`   • GET  /admin                        → Admin panel`);
    console.log('========================================');
    console.log('🧪 SKIP_WHATSAPP is ENABLED (messages will be logged, not sent)');
    console.log('   Set SKIP_WHATSAPP = false in server.js to send real WhatsApp');
    console.log('========================================');
});

module.exports = app;
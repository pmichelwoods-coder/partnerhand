// backend/server.js
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Fix for better-sqlite3 on Render
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));

// ===================== TWILIO WHATSAPP SETUP =====================

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Send WhatsApp message via Twilio
async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    // Clean phone number (remove spaces, dashes, etc.)
    let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    // Add country code if not present (Dominican Republic = +1)
    if (!cleanNumber.startsWith('1') && cleanNumber.length === 10) {
      cleanNumber = `1${cleanNumber}`;
    }
    
    // Ensure it starts with +
    if (!cleanNumber.startsWith('+')) {
      cleanNumber = `+${cleanNumber}`;
    }
    
    // Use the sandbox number
    const fromNumber = `whatsapp:${process.env.TWILIO_WHATSAPP_SANDBOX || '+14155238886'}`;
    const toNumber = `whatsapp:${cleanNumber}`;
    
    console.log(`📱 Sending WhatsApp to ${toNumber}...`);
    console.log(`📝 Message: ${message}`);
    
    // Send the message
    const twilioMessage = await twilioClient.messages.create({
      body: message,
      from: fromNumber,
      to: toNumber
    });
    
    console.log(`✅ WhatsApp sent! SID: ${twilioMessage.sid}`);
    return true;
    
  } catch (error) {
    console.error('❌ WhatsApp send error:', error);
    
    // Log the full error details
    if (error.code) {
      console.error(`Twilio Error ${error.code}: ${error.message}`);
      
      // Common errors
      if (error.code === 21608) {
        console.error('💡 This number is not authorized. Send the join code first.');
      } else if (error.code === 21211) {
        console.error('💡 Invalid phone number format. Use: 8095551234');
      } else if (error.code === 63005) {
        console.error('💡 WhatsApp sandbox not properly configured.');
      }
    }
    
    return false;
  }
}

// Create database folder if it doesn't exist
if (!fs.existsSync('./database')) {
  fs.mkdirSync('./database');
}

// Database setup with better-sqlite3
const db = new Database('./database/partnerhand.db');

// Initialize database tables (synchronous)
db.exec(`
  CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_number TEXT UNIQUE NOT NULL,
    deposit_slip TEXT NOT NULL,
    transaction_number TEXT UNIQUE NOT NULL,
    whatsapp_number TEXT NOT NULL,
    full_name TEXT,
    inviter_code TEXT,
    registration_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    expiry_date DATETIME NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    payment_earned BOOLEAN DEFAULT 0,
    transaction_approved BOOLEAN DEFAULT 0,
    transaction_date DATETIME,
    total_paid INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_code TEXT NOT NULL,
    referred_code TEXT NOT NULL,
    referral_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_code) REFERENCES partners(customer_number),
    FOREIGN KEY (referred_code) REFERENCES partners(customer_number)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_number TEXT NOT NULL,
    amount INTEGER NOT NULL,
    payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending',
    processed_date DATETIME,
    FOREIGN KEY (customer_number) REFERENCES partners(customer_number)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS master_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_code TEXT UNIQUE NOT NULL,
    created_by TEXT NOT NULL,
    created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_number TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    referral_code TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL,
    submission_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending',
    admin_notes TEXT,
    processed_date DATETIME
  )
`);

console.log('✅ Database initialized');

// Helper functions
function generateCustomerNumber() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function customerNumberExists(customerNumber) {
  const stmt = db.prepare('SELECT id FROM partners WHERE customer_number = ?');
  const result = stmt.get(customerNumber);
  return !!result;
}

async function getUniqueCustomerNumber() {
  let customerNumber = generateCustomerNumber();
  while (customerNumberExists(customerNumber)) {
    customerNumber = generateCustomerNumber();
  }
  return customerNumber;
}

// Helper: Check and process payouts for a user
async function checkAndProcessPayouts(customerNumber) {
  try {
    const stmt1 = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_code = ?');
    const countResult = stmt1.get(customerNumber);
    const totalReferrals = countResult.count;
    
    const stmt2 = db.prepare('SELECT COUNT(*) as count FROM payments WHERE customer_number = ? AND status = "completed"');
    const paymentsResult = stmt2.get(customerNumber);
    const paymentsMade = paymentsResult.count;
    
    const expectedPayouts = Math.floor(totalReferrals / 5);
    const pendingPayouts = expectedPayouts - paymentsMade;
    
    if (pendingPayouts > 0) {
      for (let i = 0; i < pendingPayouts; i++) {
        const insertStmt = db.prepare('INSERT INTO payments (customer_number, amount, status) VALUES (?, ?, ?)');
        insertStmt.run(customerNumber, 5000, 'pending');
      }
      
      const partnerStmt = db.prepare('SELECT whatsapp_number FROM partners WHERE customer_number = ?');
      const partner = partnerStmt.get(customerNumber);
      
      if (partner) {
        await sendWhatsAppMessage(
          partner.whatsapp_number,
          `🎉 Congratulations! You've earned ${pendingPayouts} new payout(s) of RD$5,000 each! Total: RD$${(pendingPayouts * 5000).toLocaleString()}\n\nYou now have ${totalReferrals} referrals. Every 5 referrals = RD$5,000! Payments are processed within 2 working days.`
        );
      }
    }
    
    return { totalReferrals, paymentsMade, expectedPayouts, pendingPayouts };
  } catch (error) {
    console.error('Error processing payouts:', error);
    return null;
  }
}

// ===================== MASTER LINK ENDPOINTS =====================

// Generate Master Referral Link
app.post('/api/admin/generate-master-link', async (req, res) => {
    try {
        const linkCode = generateCustomerNumber();
        const insertStmt = db.prepare('INSERT INTO master_links (link_code, created_by) VALUES (?, ?)');
        insertStmt.run(linkCode, 'admin');
        res.json({ success: true, linkCode });
    } catch (error) {
        console.error('Generate master link error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get Master Link Info
app.get('/api/master-link/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const stmt = db.prepare('SELECT * FROM master_links WHERE link_code = ? AND is_active = 1');
        const link = stmt.get(code);
        
        if (!link) {
            return res.status(404).json({ error: 'Invalid or expired referral link' });
        }
        
        res.json({ 
            valid: true, 
            referralCode: code,
            message: 'Welcome to Digital Partner Hand!'
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ===================== DEPOSIT SUBMISSION ENDPOINTS =====================

// Submit deposit for approval
app.post('/api/submit-deposit', async (req, res) => {
    try {
        const { transactionNumber, fullName, whatsappNumber, referralCode } = req.body;
        
        if (!transactionNumber || transactionNumber.length < 8) {
            return res.status(400).json({ error: 'Transaction number must be at least 8 digits' });
        }
        
        const checkStmt = db.prepare('SELECT id FROM pending_approvals WHERE transaction_number = ?');
        const existing = checkStmt.get(transactionNumber);
        
        if (existing) {
            return res.status(400).json({ error: 'This transaction number has already been submitted' });
        }
        
        const insertStmt = db.prepare(
            `INSERT INTO pending_approvals 
             (transaction_number, full_name, referral_code, whatsapp_number) 
             VALUES (?, ?, ?, ?)`
        );
        const result = insertStmt.run(transactionNumber, fullName, referralCode, whatsappNumber);
        
        // Send WhatsApp notification
        await sendWhatsAppMessage(
            whatsappNumber,
            `📝 Thank you for your deposit submission!\n\nWe have received your RD$1,250 deposit and it is now pending approval.\n\n⏳ Please allow 24-48 hours for verification.\n\nYou will receive a WhatsApp notification once approved.\n\nThank you for joining Digital Partner Hand! 🎉`
        );
        
        res.json({ 
            success: true, 
            message: 'Deposit of RD$1,250 submitted for approval. You will receive a WhatsApp notification once approved.',
            pendingId: result.lastInsertRowid
        });
        
    } catch (error) {
        console.error('Submit deposit error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin: Get pending approvals
app.get('/api/admin/pending-approvals', async (req, res) => {
    try {
        const stmt = db.prepare(`SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY submission_date ASC`);
        const approvals = stmt.all();
        res.json(approvals);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin: Approve or reject deposit
app.post('/api/admin/process-approval', async (req, res) => {
    try {
        const { approvalId, action, adminNotes } = req.body;
        
        if (!approvalId || !action) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const getStmt = db.prepare('SELECT * FROM pending_approvals WHERE id = ?');
        const approval = getStmt.get(approvalId);
        
        if (!approval) {
            return res.status(404).json({ error: 'Approval not found' });
        }
        
        const updateStmt = db.prepare(
            `UPDATE pending_approvals 
             SET status = ?, admin_notes = ?, processed_date = CURRENT_TIMESTAMP 
             WHERE id = ?`
        );
        updateStmt.run(action, adminNotes || null, approvalId);
        
        if (action === 'approve') {
            const customerNumber = await getUniqueCustomerNumber();
            
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + 90);
            
            const insertStmt = db.prepare(
                `INSERT INTO partners 
                 (customer_number, deposit_slip, transaction_number, whatsapp_number, 
                  full_name, inviter_code, expiry_date, transaction_approved) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            insertStmt.run(
                customerNumber, 
                approval.transaction_number, 
                approval.transaction_number, 
                approval.whatsapp_number,
                approval.full_name,
                approval.referral_code,
                expiryDate.toISOString(),
                1
            );
            
            if (approval.referral_code) {
                const referralStmt = db.prepare(
                    `INSERT INTO referrals (referrer_code, referred_code) VALUES (?, ?)`
                );
                referralStmt.run(approval.referral_code, customerNumber);
                
                const payoutResult = await checkAndProcessPayouts(approval.referral_code);
                
                const referrerStmt = db.prepare(
                    'SELECT whatsapp_number, customer_number FROM partners WHERE customer_number = ?'
                );
                const referrer = referrerStmt.get(approval.referral_code);
                
                if (referrer) {
                    let message = `🎯 New referral! ${approval.full_name} has joined under you.`;
                    if (payoutResult) {
                        message += `\n\n📊 Your Stats:\n• Total Referrals: ${payoutResult.totalReferrals}\n• Payouts Earned: ${payoutResult.paymentsMade}\n• Pending Payouts: ${payoutResult.pendingPayouts}`;
                        if (payoutResult.pendingPayouts > 0) {
                            message += `\n💰 RD$${(payoutResult.pendingPayouts * 5000).toLocaleString()} pending (processing within 2 working days)`;
                        }
                    }
                    await sendWhatsAppMessage(
                        referrer.whatsapp_number,
                        message
                    );
                }
            }
            
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            await sendWhatsAppMessage(
                approval.whatsapp_number,
                `🎉 Welcome to Digital Partner Hand!\n\n✅ Your entry fee of RD$1,250 has been approved!\n🔑 Your Customer Number: ${customerNumber}\n🔗 Your Referral Link: ${baseUrl}/join?ref=${customerNumber}\n\n📋 How it works:\n• Share your link with friends\n• Earn RD$5,000 for every 5 referrals\n• Unlimited earnings!\n• Payments processed within 2 working days\n\nStart sharing and earning today! 🚀`
            );
        }
        
        res.json({ 
            success: true, 
            message: action === 'approve' ? 'Approved successfully!' : 'Rejected successfully!' 
        });
        
    } catch (error) {
        console.error('Process approval error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ===================== ORIGINAL ENDPOINTS =====================

// API: Register new partner
app.post('/api/register', async (req, res) => {
  try {
    const { depositSlip, transactionNumber, inviterCode, whatsappNumber } = req.body;

    if (!depositSlip || !transactionNumber || !whatsappNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const checkStmt = db.prepare('SELECT id FROM partners WHERE transaction_number = ?');
    const existingTransaction = checkStmt.get(transactionNumber);

    if (existingTransaction) {
      return res.status(400).json({ error: 'Transaction number already used' });
    }

    const customerNumber = await getUniqueCustomerNumber();

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 90);

    const insertStmt = db.prepare(
      `INSERT INTO partners 
       (customer_number, deposit_slip, transaction_number, whatsapp_number, 
        inviter_code, expiry_date) 
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertStmt.run(
      customerNumber, 
      depositSlip, 
      transactionNumber, 
      whatsappNumber, 
      inviterCode || null, 
      expiryDate.toISOString()
    );

    let referralCount = 0;

    if (inviterCode) {
      const inviterStmt = db.prepare('SELECT * FROM partners WHERE customer_number = ?');
      const inviterData = inviterStmt.get(inviterCode);

      if (inviterData) {
        const refStmt = db.prepare(
          `INSERT INTO referrals (referrer_code, referred_code) VALUES (?, ?)`
        );
        refStmt.run(inviterCode, customerNumber);

        await checkAndProcessPayouts(inviterCode);
        
        const countStmt = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_code = ?');
        const countResult = countStmt.get(inviterCode);
        referralCount = countResult.count;
      }
    }

    await sendWhatsAppMessage(
      whatsappNumber,
      `🎯 Welcome to Digital Partner Hand!\n\nYour Customer Number: ${customerNumber}\nValid for: 90 days\n\nShare your referral link to earn RD$5,000 for every 5 referrals!`
    );

    res.json({
      success: true,
      customerNumber,
      expiryDate: expiryDate.toISOString(),
      referrals: referralCount,
      message: 'Registration successful!'
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Check partner status
app.post('/api/check-status', async (req, res) => {
  try {
    const { customerNumber } = req.body;

    if (!customerNumber) {
      return res.status(400).json({ error: 'Customer number required' });
    }

    const partnerStmt = db.prepare('SELECT * FROM partners WHERE customer_number = ?');
    const partner = partnerStmt.get(customerNumber.toUpperCase());

    if (!partner) {
      return res.status(404).json({ error: 'Customer number not found' });
    }

    const refCountStmt = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_code = ?');
    const referralData = refCountStmt.get(partner.customer_number);

    const referralsStmt = db.prepare('SELECT referred_code FROM referrals WHERE referrer_code = ?');
    const referrals = referralsStmt.all(partner.customer_number);

    const paymentsStmt = db.prepare('SELECT * FROM payments WHERE customer_number = ? ORDER BY payment_date DESC');
    const payments = paymentsStmt.all(partner.customer_number);

    const completedPayments = payments.filter(p => p.status === 'completed');
    const pendingPayments = payments.filter(p => p.status === 'pending');
    
    const expectedPayouts = Math.floor(referralData.count / 5);
    const totalPaid = completedPayments.reduce((sum, p) => sum + p.amount, 0);
    const totalPending = pendingPayments.reduce((sum, p) => sum + p.amount, 0);

    const isActive = new Date(partner.expiry_date) > new Date();
    const daysLeft = Math.ceil((new Date(partner.expiry_date) - new Date()) / (1000 * 60 * 60 * 24));

    res.json({
      customerNumber: partner.customer_number,
      isActive,
      daysLeft: daysLeft > 0 ? daysLeft : 0,
      registrationDate: partner.registration_date,
      expiryDate: partner.expiry_date,
      referralCount: referralData.count,
      referralsList: referrals.map(r => r.referred_code),
      expectedPayouts: expectedPayouts,
      completedPayments: completedPayments.length,
      pendingPayments: pendingPayments.length,
      totalPaid: totalPaid,
      totalPending: totalPending,
      whatsappNumber: partner.whatsapp_number,
      fullName: partner.full_name || 'N/A',
      paymentHistory: payments.map(p => ({
        amount: p.amount,
        payment_date: p.payment_date,
        status: p.status
      }))
    });

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Admin stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const partnersStmt = db.prepare('SELECT COUNT(*) as count FROM partners');
    const totalPartners = partnersStmt.get();

    const referralsStmt = db.prepare('SELECT COUNT(*) as count FROM referrals');
    const totalReferrals = referralsStmt.get();

    const pendingPaymentsStmt = db.prepare('SELECT COUNT(*) as count FROM payments WHERE status = "pending"');
    const pendingPayments = pendingPaymentsStmt.get();

    const pendingApprovalsStmt = db.prepare('SELECT COUNT(*) as count FROM pending_approvals WHERE status = "pending"');
    const pendingApprovals = pendingApprovalsStmt.get();

    res.json({
      totalPartners: totalPartners.count,
      totalReferrals: totalReferrals.count,
      pendingPayments: pendingPayments.count,
      pendingApprovals: pendingApprovals.count
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Get pending payments
app.get('/api/admin/pending-payments', async (req, res) => {
  try {
    const stmt = db.prepare(
      `SELECT p.*, pa.whatsapp_number, pa.full_name 
       FROM payments p 
       JOIN partners pa ON p.customer_number = pa.customer_number 
       WHERE p.status = 'pending' 
       ORDER BY p.payment_date ASC`
    );
    const payments = stmt.all();
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Process payment
app.post('/api/admin/process-payment', async (req, res) => {
  try {
    const { customerNumber } = req.body;

    if (!customerNumber) {
      return res.status(400).json({ error: 'Customer number required' });
    }

    const paymentStmt = db.prepare(
      'SELECT * FROM payments WHERE customer_number = ? AND status = "pending" ORDER BY payment_date ASC LIMIT 1'
    );
    const payment = paymentStmt.get(customerNumber);

    if (!payment) {
      return res.status(404).json({ error: 'No pending payment found' });
    }

    const updateStmt = db.prepare(
      `UPDATE payments SET status = 'completed', processed_date = CURRENT_TIMESTAMP 
       WHERE id = ?`
    );
    updateStmt.run(payment.id);

    const totalStmt = db.prepare(
      `UPDATE partners SET total_paid = total_paid + ? WHERE customer_number = ?`
    );
    totalStmt.run(payment.amount, customerNumber);

    const partnerStmt = db.prepare(
      'SELECT whatsapp_number, full_name FROM partners WHERE customer_number = ?'
    );
    const partner = partnerStmt.get(customerNumber);

    if (partner) {
      await sendWhatsAppMessage(
        partner.whatsapp_number,
        `💰 Payment Processed!\n\nDear ${partner.full_name || 'Partner'},\n\nYour payment of RD$${payment.amount.toLocaleString()} has been processed successfully.\n\nThank you for being part of Digital Partner Hand! 🎉`
      );
    }

    res.json({ success: true, message: 'Payment processed successfully' });

  } catch (error) {
    console.error('Process payment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===================== TEST WHATSAPP ENDPOINT =====================

// Test WhatsApp endpoint
app.post('/api/test-whatsapp', async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    
    if (!phoneNumber || !message) {
      return res.status(400).json({ 
        error: 'Phone number and message required',
        tip: 'Use format: {"phoneNumber":"8095551234","message":"Hello"}'
      });
    }

    const result = await sendWhatsAppMessage(phoneNumber, message);
    
    if (result) {
      res.json({ 
        success: true, 
        message: 'WhatsApp sent successfully',
        to: phoneNumber
      });
    } else {
      res.status(500).json({ error: 'Failed to send WhatsApp' });
    }
    
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===================== SERVE STATIC FILES =====================

// Serve static files from frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));

// Main routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/customer', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/customer.html'));
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/join.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📱 Admin: http://localhost:${PORT}`);
  console.log(`👥 Customer: http://localhost:${PORT}/customer`);
  console.log(`🔗 Join Page: http://localhost:${PORT}/join`);
  console.log(`💡 Press Ctrl+C to stop`);
});
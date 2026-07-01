// backend/server.js
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Fix for sqlite3 on Render
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Create database folder if it doesn't exist
if (!fs.existsSync('./database')) {
  fs.mkdirSync('./database');
}

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
    let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    if (!cleanNumber.startsWith('1') && cleanNumber.length === 10) {
      cleanNumber = `1${cleanNumber}`;
    }
    
    if (!cleanNumber.startsWith('+')) {
      cleanNumber = `+${cleanNumber}`;
    }
    
    const fromNumber = `whatsapp:${process.env.TWILIO_WHATSAPP_SANDBOX || '+14155238886'}`;
    const toNumber = `whatsapp:${cleanNumber}`;
    
    console.log(`📱 Sending WhatsApp to ${toNumber}...`);
    console.log(`📝 Message: ${message}`);
    
    const twilioMessage = await twilioClient.messages.create({
      body: message,
      from: fromNumber,
      to: toNumber
    });
    
    console.log(`✅ WhatsApp sent! SID: ${twilioMessage.sid}`);
    return true;
    
  } catch (error) {
    console.error('❌ WhatsApp send error:', error);
    
    if (error.code) {
      console.error(`Twilio Error ${error.code}: ${error.message}`);
      
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

// ===================== DATABASE SETUP =====================

const db = new sqlite3.Database('./database/partnerhand.db');

// Initialize database tables
db.serialize(() => {
  db.run(`
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

  db.run(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_code TEXT NOT NULL,
      referred_code TEXT NOT NULL,
      referral_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (referrer_code) REFERENCES partners(customer_number),
      FOREIGN KEY (referred_code) REFERENCES partners(customer_number)
    )
  `);

  db.run(`
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

  db.run(`
    CREATE TABLE IF NOT EXISTS master_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_code TEXT UNIQUE NOT NULL,
      created_by TEXT NOT NULL,
      created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT 1
    )
  `);

  db.run(`
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
});

// ===================== HELPER FUNCTIONS =====================

function generateCustomerNumber() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function customerNumberExists(customerNumber) {
  return new Promise((resolve) => {
    db.get(
      'SELECT id FROM partners WHERE customer_number = ?',
      [customerNumber],
      (err, row) => resolve(!!row)
    );
  });
}

async function getUniqueCustomerNumber() {
  let customerNumber = generateCustomerNumber();
  while (await customerNumberExists(customerNumber)) {
    customerNumber = generateCustomerNumber();
  }
  return customerNumber;
}

async function checkAndProcessPayouts(customerNumber) {
  try {
    const countResult = await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as count FROM referrals WHERE referrer_code = ?',
        [customerNumber],
        (err, row) => resolve(row)
      );
    });
    
    const totalReferrals = countResult.count;
    
    const paymentsResult = await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as count FROM payments WHERE customer_number = ? AND status = "completed"',
        [customerNumber],
        (err, row) => resolve(row)
      );
    });
    
    const paymentsMade = paymentsResult.count;
    const expectedPayouts = Math.floor(totalReferrals / 5);
    const pendingPayouts = expectedPayouts - paymentsMade;
    
    if (pendingPayouts > 0) {
      for (let i = 0; i < pendingPayouts; i++) {
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO payments (customer_number, amount, status) VALUES (?, ?, ?)`,
            [customerNumber, 5000, 'pending'],
            (err) => {
              if (err) reject(err);
              resolve();
            }
          );
        });
      }
      
      const partner = await new Promise((resolve) => {
        db.get(
          'SELECT whatsapp_number FROM partners WHERE customer_number = ?',
          [customerNumber],
          (err, row) => resolve(row)
        );
      });
      
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

// ===================== ENDPOINTS =====================

// Generate Master Referral Link
app.post('/api/admin/generate-master-link', async (req, res) => {
  try {
    const linkCode = generateCustomerNumber();
    db.run(
      `INSERT INTO master_links (link_code, created_by) VALUES (?, ?)`,
      [linkCode, 'admin'],
      (err) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Server error' });
        }
        res.json({ success: true, linkCode });
      }
    );
  } catch (error) {
    console.error('Generate master link error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Master Link Info
app.get('/api/master-link/:code', async (req, res) => {
  try {
    const { code } = req.params;
    db.get(
      'SELECT * FROM master_links WHERE link_code = ? AND is_active = 1',
      [code],
      (err, link) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Server error' });
        }
        if (!link) {
          return res.status(404).json({ error: 'Invalid or expired referral link' });
        }
        res.json({ 
          valid: true, 
          referralCode: code,
          message: 'Welcome to Digital Partner Hand!'
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit deposit for approval
app.post('/api/submit-deposit', async (req, res) => {
  try {
    const { transactionNumber, fullName, whatsappNumber, referralCode } = req.body;
    
    if (!transactionNumber || transactionNumber.length < 8) {
      return res.status(400).json({ error: 'Transaction number must be at least 8 digits' });
    }
    
    db.get(
      'SELECT id FROM pending_approvals WHERE transaction_number = ?',
      [transactionNumber],
      async (err, existing) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Server error' });
        }
        
        if (existing) {
          return res.status(400).json({ error: 'This transaction number has already been submitted' });
        }
        
        db.run(
          `INSERT INTO pending_approvals 
           (transaction_number, full_name, referral_code, whatsapp_number) 
           VALUES (?, ?, ?, ?)`,
          [transactionNumber, fullName, referralCode, whatsappNumber],
          async function(err) {
            if (err) {
              console.error(err);
              return res.status(500).json({ error: 'Server error' });
            }
            
            await sendWhatsAppMessage(
              whatsappNumber,
              `📝 Thank you for your deposit submission!\n\nWe have received your RD$1,250 deposit and it is now pending approval.\n\n⏳ Please allow 24-48 hours for verification.\n\nYou will receive a WhatsApp notification once approved.\n\nThank you for joining Digital Partner Hand! 🎉`
            );
            
            res.json({ 
              success: true, 
              message: 'Deposit of RD$1,250 submitted for approval. You will receive a WhatsApp notification once approved.',
              pendingId: this.lastID
            });
          }
        );
      }
    );
  } catch (error) {
    console.error('Submit deposit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get pending approvals
app.get('/api/admin/pending-approvals', async (req, res) => {
  try {
    db.all(
      `SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY submission_date ASC`,
      (err, rows) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Server error' });
        }
        res.json(rows || []);
      }
    );
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
    
    db.get(
      'SELECT * FROM pending_approvals WHERE id = ?',
      [approvalId],
      async (err, approval) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Server error' });
        }
        
        if (!approval) {
          return res.status(404).json({ error: 'Approval not found' });
        }
        
        db.run(
          `UPDATE pending_approvals 
           SET status = ?, admin_notes = ?, processed_date = CURRENT_TIMESTAMP 
           WHERE id = ?`,
          [action, adminNotes || null, approvalId],
          async function(err) {
            if (err) {
              console.error(err);
              return res.status(500).json({ error: 'Server error' });
            }
            
            if (action === 'approve') {
              const customerNumber = await getUniqueCustomerNumber();
              const expiryDate = new Date();
              expiryDate.setDate(expiryDate.getDate() + 90);
              
              db.run(
                `INSERT INTO partners 
                 (customer_number, deposit_slip, transaction_number, whatsapp_number, 
                  full_name, inviter_code, expiry_date, transaction_approved) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  customerNumber, 
                  approval.transaction_number, 
                  approval.transaction_number, 
                  approval.whatsapp_number,
                  approval.full_name,
                  approval.referral_code,
                  expiryDate.toISOString(),
                  1
                ],
                async function(err) {
                  if (err) {
                    console.error(err);
                    return res.status(500).json({ error: 'Server error' });
                  }
                  
                  if (approval.referral_code) {
                    db.run(
                      `INSERT INTO referrals (referrer_code, referred_code) VALUES (?, ?)`,
                      [approval.referral_code, customerNumber],
                      async (err) => {
                        if (err) console.error(err);
                        const payoutResult = await checkAndProcessPayouts(approval.referral_code);
                        
                        db.get(
                          'SELECT whatsapp_number, customer_number FROM partners WHERE customer_number = ?',
                          [approval.referral_code],
                          async (err, referrer) => {
                            if (referrer) {
                              let message = `🎯 New referral! ${approval.full_name} has joined under you.`;
                              if (payoutResult) {
                                message += `\n\n📊 Your Stats:\n• Total Referrals: ${payoutResult.totalReferrals}\n• Payouts Earned: ${payoutResult.paymentsMade}\n• Pending Payouts: ${payoutResult.pendingPayouts}`;
                                if (payoutResult.pendingPayouts > 0) {
                                  message += `\n💰 RD$${(payoutResult.pendingPayouts * 5000).toLocaleString()} pending (processing within 2 working days)`;
                                }
                              }
                              await sendWhatsAppMessage(referrer.whatsapp_number, message);
                            }
                          }
                        );
                      }
                    );
                  }
                  
                  const baseUrl = `${req.protocol}://${req.get('host')}`;
                  await sendWhatsAppMessage(
                    approval.whatsapp_number,
                    `🎉 Welcome to Digital Partner Hand!\n\n✅ Your entry fee of RD$1,250 has been approved!\n🔑 Your Customer Number: ${customerNumber}\n🔗 Your Referral Link: ${baseUrl}/join?ref=${customerNumber}\n\n📋 How it works:\n• Share your link with friends\n• Earn RD$5,000 for every 5 referrals\n• Unlimited earnings!\n• Payments processed within 2 working days\n\nStart sharing and earning today! 🚀`
                  );
                }
              );
            }
            
            res.json({ 
              success: true, 
              message: action === 'approve' ? 'Approved successfully!' : 'Rejected successfully!' 
            });
          }
        );
      }
    );
  } catch (error) {
    console.error('Process approval error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===================== TEST WHATSAPP ENDPOINT =====================

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

app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/customer', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/customer.html'));
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/join.html'));
});

// ===================== START SERVER =====================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📱 Admin: http://localhost:${PORT}`);
  console.log(`👥 Customer: http://localhost:${PORT}/customer`);
  console.log(`🔗 Join Page: http://localhost:${PORT}/join`);
  console.log(`💡 Press Ctrl+C to stop`);
});
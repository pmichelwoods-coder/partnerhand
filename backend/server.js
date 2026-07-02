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
        const message = `🎉 ¡Felicidades! / Congratulations!\n\n` +
          `🇪🇸 Has ganado ${pendingPayouts} nuevo(s) pago(s) de RD$5,000 cada uno! Total: RD$${(pendingPayouts * 5000).toLocaleString()}\n\n` +
          `🇺🇸 You've earned ${pendingPayouts} new payout(s) of RD$5,000 each! Total: RD$${(pendingPayouts * 5000).toLocaleString()}\n\n` +
          `📊 ${totalReferrals} referidos / referrals\n` +
          `💰 Procesado en 2 días hábiles / Processed within 2 working days`;
        
        await sendWhatsAppMessage(partner.whatsapp_number, message);
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
      return res.status(400).json({ 
        error: '❌ El número de transacción debe tener al menos 8 dígitos.' 
      });
    }
    
    if (!fullName) {
      return res.status(400).json({ 
        error: '❌ Por favor ingresa tu nombre completo.' 
      });
    }
    
    if (!whatsappNumber || whatsappNumber.length < 10) {
      return res.status(400).json({ 
        error: '❌ Por favor ingresa un número de WhatsApp válido (10 dígitos).' 
      });
    }
    
    // Check if already approved
    db.get(
      'SELECT id FROM partners WHERE transaction_number = ?',
      [transactionNumber],
      async (err, approved) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: '❌ Error del servidor. Por favor intenta de nuevo.' });
        }
        
        if (approved) {
          return res.status(400).json({ 
            error: '✅ Este depósito ya ha sido aprobado. Por favor revisa tu WhatsApp para tu número de cliente.' 
          });
        }
        
        // Check for duplicate pending approval
        db.get(
          'SELECT id FROM pending_approvals WHERE transaction_number = ?',
          [transactionNumber],
          async (err, existing) => {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: '❌ Error del servidor. Por favor intenta de nuevo.' });
            }
            
            if (existing) {
              return res.status(400).json({ 
                error: '❌ Este número de transacción ya ha sido enviado para aprobación. Por favor espera 24-48 horas para la verificación.' 
              });
            }
            
            // Insert new pending approval
            db.run(
              `INSERT INTO pending_approvals 
               (transaction_number, full_name, referral_code, whatsapp_number) 
               VALUES (?, ?, ?, ?)`,
              [transactionNumber, fullName, referralCode || null, whatsappNumber],
              async function(err) {
                if (err) {
                  console.error('Insert error:', err);
                  return res.status(500).json({ error: '❌ Error al guardar el depósito. Por favor intenta de nuevo.' });
                }
                
                const message = `📝 ¡Gracias por tu depósito!\n\nHemos recibido tu depósito de RD$1,250 y está pendiente de aprobación.\n\n⏳ Por favor espera 24-48 horas para la verificación.\n\nRecibirás una notificación cuando sea aprobado.\n\n¡Gracias por unirte a Digital Partner Hand! 🎉`;
                
                await sendWhatsAppMessage(whatsappNumber, message);
                
                res.json({ 
                  success: true, 
                  message: '✅ Depósito enviado exitosamente! Recibirás una notificación cuando sea aprobado.',
                  pendingId: this.lastID
                });
              }
            );
          }
        );
      }
    );
  } catch (error) {
    console.error('Submit deposit error:', error);
    res.status(500).json({ error: '❌ Error del servidor. Por favor intenta de nuevo.' });
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
                    console.error('Error inserting partner:', err);
                    return res.status(500).json({ error: 'Server error' });
                  }
                  
                  const baseUrl = `https://partnerhand-app.onrender.com`;
                  const welcomeMessage = 
                    `🎉 ¡Bienvenido a Digital Partner Hand! / Welcome to Digital Partner Hand!\n\n` +
                    `✅ Tu entrada de RD$1,250 ha sido aprobada / Your entry fee of RD$1,250 has been approved!\n` +
                    `🔑 Tu número de cliente / Your Customer Number: ${customerNumber}\n` +
                    `🔗 Tu enlace de referidos / Your Referral Link: ${baseUrl}/join?ref=${customerNumber}\n\n` +
                    `📋 Cómo funciona / How it works:\n` +
                    `• Comparte tu enlace con amigos / Share your link with friends\n` +
                    `• Gana RD$5,000 por cada 5 referidos / Earn RD$5,000 for every 5 referrals\n` +
                    `• Ganancias ilimitadas / Unlimited earnings!\n` +
                    `• Pagos procesados en 2 días hábiles / Payments processed within 2 working days\n\n` +
                    `¡Empieza a compartir y ganar hoy! / Start sharing and earning today! 🚀`;
                  
                  console.log(`📤 Sending welcome message to ${approval.whatsapp_number}...`);
                  await sendWhatsAppMessage(approval.whatsapp_number, welcomeMessage);
                  
                  if (approval.referral_code) {
                    db.run(
                      `INSERT INTO referrals (referrer_code, referred_code) VALUES (?, ?)`,
                      [approval.referral_code, customerNumber],
                      async (err) => {
                        if (err) console.error('Referral error:', err);
                        const payoutResult = await checkAndProcessPayouts(approval.referral_code);
                        
                        db.get(
                          'SELECT whatsapp_number, customer_number FROM partners WHERE customer_number = ?',
                          [approval.referral_code],
                          async (err, referrer) => {
                            if (referrer) {
                              let message = `🎯 ¡Nuevo referido! / New referral!\n\n` +
                                `🇪🇸 ${approval.full_name} se ha unido bajo tu enlace.\n` +
                                `🇺🇸 ${approval.full_name} has joined under you.\n\n`;
                              
                              if (payoutResult) {
                                message += `📊 ${payoutResult.totalReferrals} referidos / referrals\n` +
                                  `💰 Pagos ganados / Payouts Earned: ${payoutResult.paymentsMade}\n` +
                                  `⏳ Pagos pendientes / Pending Payouts: ${payoutResult.pendingPayouts}`;
                                if (payoutResult.pendingPayouts > 0) {
                                  message += `\n💰 RD$${(payoutResult.pendingPayouts * 5000).toLocaleString()} pendiente (procesado en 2 días hábiles) / pending (processed within 2 working days)`;
                                }
                              }
                              await sendWhatsAppMessage(referrer.whatsapp_number, message);
                            }
                          }
                        );
                      }
                    );
                  }
                  
                  res.json({ 
                    success: true, 
                    message: 'Approved successfully! Welcome message sent to customer.'
                  });
                }
              );
            } else {
              res.json({ 
                success: true, 
                message: 'Rejected successfully!' 
              });
            }
          }
        );
      }
    );
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

    db.get(
      'SELECT id FROM partners WHERE transaction_number = ?',
      [transactionNumber],
      async (err, existingTransaction) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Server error' });
        }

        if (existingTransaction) {
          return res.status(400).json({ error: 'Transaction number already used' });
        }

        const customerNumber = await getUniqueCustomerNumber();

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 90);

        db.run(
          `INSERT INTO partners 
           (customer_number, deposit_slip, transaction_number, whatsapp_number, 
            inviter_code, expiry_date) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            customerNumber, 
            depositSlip, 
            transactionNumber, 
            whatsappNumber, 
            inviterCode || null, 
            expiryDate.toISOString()
          ],
          async function(err) {
            if (err) {
              console.error(err);
              return res.status(500).json({ error: 'Server error' });
            }

            let referralCount = 0;

            if (inviterCode) {
              db.get(
                'SELECT * FROM partners WHERE customer_number = ?',
                [inviterCode],
                async (err, inviterData) => {
                  if (inviterData) {
                    db.run(
                      `INSERT INTO referrals (referrer_code, referred_code) VALUES (?, ?)`,
                      [inviterCode, customerNumber],
                      async (err) => {
                        if (err) console.error(err);
                        await checkAndProcessPayouts(inviterCode);
                        
                        db.get(
                          'SELECT COUNT(*) as count FROM referrals WHERE referrer_code = ?',
                          [inviterCode],
                          (err, countResult) => {
                            referralCount = countResult ? countResult.count : 0;
                          }
                        );
                      }
                    );
                  }
                }
              );
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
          }
        );
      }
    );
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

    db.get(
      'SELECT * FROM partners WHERE customer_number = ?',
      [customerNumber.toUpperCase()],
      (err, partner) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Server error' });
        }

        if (!partner) {
          return res.status(404).json({ error: 'Customer number not found' });
        }

        db.get(
          'SELECT COUNT(*) as count FROM referrals WHERE referrer_code = ?',
          [partner.customer_number],
          (err, referralData) => {
            if (err) {
              console.error(err);
              return res.status(500).json({ error: 'Server error' });
            }

            db.all(
              'SELECT referred_code FROM referrals WHERE referrer_code = ?',
              [partner.customer_number],
              (err, referrals) => {
                if (err) {
                  console.error(err);
                  return res.status(500).json({ error: 'Server error' });
                }

                db.all(
                  'SELECT * FROM payments WHERE customer_number = ? ORDER BY payment_date DESC',
                  [partner.customer_number],
                  (err, payments) => {
                    if (err) {
                      console.error(err);
                      return res.status(500).json({ error: 'Server error' });
                    }

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
                  }
                );
              }
            );
          }
        );
      }
    );
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===================== ADMIN STATS (FIXED) =====================

// API: Admin stats - FIXED with callback queries
app.get('/api/admin/stats', async (req, res) => {
  try {
    // Get total partners
    db.get('SELECT COUNT(*) as count FROM partners', (err, partnersResult) => {
      if (err) {
        console.error('Partners count error:', err);
        return res.status(500).json({ error: 'Server error' });
      }
      
      // Get total referrals
      db.get('SELECT COUNT(*) as count FROM referrals', (err, referralsResult) => {
        if (err) {
          console.error('Referrals count error:', err);
          return res.status(500).json({ error: 'Server error' });
        }
        
        // Get pending payments
        db.get('SELECT COUNT(*) as count FROM payments WHERE status = "pending"', (err, paymentsResult) => {
          if (err) {
            console.error('Payments count error:', err);
            return res.status(500).json({ error: 'Server error' });
          }
          
          // Get pending approvals
          db.get('SELECT COUNT(*) as count FROM pending_approvals WHERE status = "pending"', (err, approvalsResult) => {
            if (err) {
              console.error('Approvals count error:', err);
              return res.status(500).json({ error: 'Server error' });
            }
            
            res.json({
              totalPartners: partnersResult ? partnersResult.count : 0,
              totalReferrals: referralsResult ? referralsResult.count : 0,
              pendingPayments: paymentsResult ? paymentsResult.count : 0,
              pendingApprovals: approvalsResult ? approvalsResult.count : 0
            });
          });
        });
      });
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Get pending payments
app.get('/api/admin/pending-payments', async (req, res) => {
  try {
    db.all(
      `SELECT 
        p.id,
        p.customer_number,
        p.amount,
        p.payment_date,
        p.status,
        p.processed_date,
        pa.full_name,
        pa.whatsapp_number
       FROM payments p 
       LEFT JOIN partners pa ON p.customer_number = pa.customer_number 
       WHERE p.status = 'pending' 
       ORDER BY p.payment_date ASC`,
      (err, payments) => {
        if (err) {
          console.error('Pending payments error:', err);
          return res.status(500).json({ error: 'Server error: ' + err.message });
        }
        console.log('📊 Pending payments found:', payments ? payments.length : 0);
        res.json(payments || []);
      }
    );
  } catch (error) {
    console.error('Pending payments catch error:', error);
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

    db.get(
      'SELECT * FROM payments WHERE customer_number = ? AND status = "pending" ORDER BY payment_date ASC LIMIT 1',
      [customerNumber],
      (err, payment) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Server error' });
        }

        if (!payment) {
          return res.status(404).json({ error: 'No pending payment found' });
        }

        db.run(
          `UPDATE payments SET status = 'completed', processed_date = CURRENT_TIMESTAMP WHERE id = ?`,
          [payment.id],
          function(err) {
            if (err) {
              console.error(err);
              return res.status(500).json({ error: 'Server error' });
            }

            db.run(
              `UPDATE partners SET total_paid = total_paid + ? WHERE customer_number = ?`,
              [payment.amount, customerNumber],
              function(err) {
                if (err) {
                  console.error(err);
                  return res.status(500).json({ error: 'Server error' });
                }

                db.get(
                  'SELECT whatsapp_number, full_name FROM partners WHERE customer_number = ?',
                  [customerNumber],
                  async (err, partner) => {
                    if (partner) {
                      await sendWhatsAppMessage(
                        partner.whatsapp_number,
                        `💰 Payment Processed!\n\nDear ${partner.full_name || 'Partner'},\n\nYour payment of RD$${payment.amount.toLocaleString()} has been processed successfully.\n\nThank you for being part of Digital Partner Hand! 🎉`
                      );
                    }

                    res.json({ success: true, message: 'Payment processed successfully' });
                  }
                );
              }
            );
          }
        );
      }
    );
  } catch (error) {
    console.error('Process payment error:', error);
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
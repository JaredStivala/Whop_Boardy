// server.js - Main Express Server
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize database tables
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // Groups table - stores Whop community configurations
    await client.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        whop_company_id VARCHAR(255) UNIQUE NOT NULL,
        group_name VARCHAR(255) NOT NULL,
        webhook_secret VARCHAR(255),
        custom_questions JSONB DEFAULT '[]',
        branding JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Waitlist responses table
    await client.query(`
      CREATE TABLE IF NOT EXISTS waitlist_responses (
        id SERIAL PRIMARY KEY,
        whop_company_id VARCHAR(255) NOT NULL,
        user_email VARCHAR(255),
        user_id VARCHAR(255),
        responses JSONB NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (whop_company_id) REFERENCES groups(whop_company_id)
      )
    `);

    // Members directory table
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        whop_company_id VARCHAR(255) NOT NULL,
        whop_user_id VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        name VARCHAR(255),
        waitlist_responses JSONB,
        membership_data JSONB,
        status VARCHAR(50) DEFAULT 'active',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (whop_company_id) REFERENCES groups(whop_company_id),
        UNIQUE(whop_company_id, whop_user_id)
      )
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  } finally {
    client.release();
  }
}

// Webhook signature verification
function verifyWebhookSignature(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

// Main webhook endpoint for Whop events
app.post('/webhook/whop', async (req, res) => {
  try {
    const signature = req.headers['x-whop-signature'];
    const payload = JSON.stringify(req.body);
    
    // Get company info to verify webhook
    const companyId = req.body.data?.company_id || req.body.company_id;
    if (!companyId) {
      return res.status(400).json({ error: 'No company ID found' });
    }

    // Get webhook secret for this company
    const groupResult = await pool.query(
      'SELECT webhook_secret FROM groups WHERE whop_company_id = $1',
      [companyId]
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not registered' });
    }

    const webhookSecret = groupResult.rows[0].webhook_secret;
    
    // Verify signature if secret is set
    if (webhookSecret && signature) {
      if (!verifyWebhookSignature(payload, signature.replace('sha256=', ''), webhookSecret)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const eventType = req.body.type;
    const eventData = req.body.data;

    console.log(`Received webhook: ${eventType} for company: ${companyId}`);

    switch (eventType) {
      case 'membership_went_valid':
        await handleMembershipValid(eventData, companyId);
        break;
      
      case 'membership_went_invalid':
        await handleMembershipInvalid(eventData, companyId);
        break;
      
      case 'waitlist_submission':
        await handleWaitlistSubmission(eventData, companyId);
        break;
      
      default:
        console.log(`Unhandled webhook event: ${eventType}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle when membership becomes valid (approved from waitlist)
async function handleMembershipValid(data, companyId) {
  try {
    const userId = data.user_id || data.user?.id;
    const userEmail = data.user?.email;
    const userName = data.user?.username || data.user?.name;

    // Check if we have waitlist data for this user
    const waitlistResult = await pool.query(
      'SELECT * FROM waitlist_responses WHERE whop_company_id = $1 AND (user_id = $2 OR user_email = $3) ORDER BY submitted_at DESC LIMIT 1',
      [companyId, userId, userEmail]
    );

    const waitlistData = waitlistResult.rows[0]?.responses || {};

    // Insert or update member in directory
    await pool.query(`
      INSERT INTO members (whop_company_id, whop_user_id, email, name, waitlist_responses, membership_data, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'active')
      ON CONFLICT (whop_company_id, whop_user_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        waitlist_responses = EXCLUDED.waitlist_responses,
        membership_data = EXCLUDED.membership_data,
        status = 'active',
        joined_at = CURRENT_TIMESTAMP
    `, [companyId, userId, userEmail, userName, JSON.stringify(waitlistData), JSON.stringify(data)]);

    // Update waitlist status
    if (waitlistResult.rows.length > 0) {
      await pool.query(
        'UPDATE waitlist_responses SET status = $1 WHERE id = $2',
        ['approved', waitlistResult.rows[0].id]
      );
    }

    console.log(`Added member ${userId} to directory for company ${companyId}`);
  } catch (error) {
    console.error('Error handling membership_went_valid:', error);
  }
}

// Handle when membership becomes invalid
async function handleMembershipInvalid(data, companyId) {
  try {
    const userId = data.user_id || data.user?.id;
    
    await pool.query(
      'UPDATE members SET status = $1 WHERE whop_company_id = $2 AND whop_user_id = $3',
      ['inactive', companyId, userId]
    );

    console.log(`Deactivated member ${userId} for company ${companyId}`);
  } catch (error) {
    console.error('Error handling membership_went_invalid:', error);
  }
}

// Handle waitlist submissions (if Whop adds this event)
async function handleWaitlistSubmission(data, companyId) {
  try {
    const userId = data.user_id || data.user?.id;
    const userEmail = data.user?.email;
    const responses = data.responses || data.answers || {};

    await pool.query(`
      INSERT INTO waitlist_responses (whop_company_id, user_email, user_id, responses, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `, [companyId, userEmail, userId, JSON.stringify(responses)]);

    console.log(`Stored waitlist submission for company ${companyId}`);
  } catch (error) {
    console.error('Error handling waitlist submission:', error);
  }
}

// API Routes

// Register a new Whop group
app.post('/api/register-group', async (req, res) => {
  try {
    const { whop_company_id, group_name, webhook_secret, custom_questions, branding } = req.body;

    const result = await pool.query(`
      INSERT INTO groups (whop_company_id, group_name, webhook_secret, custom_questions, branding)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (whop_company_id)
      DO UPDATE SET
        group_name = EXCLUDED.group_name,
        webhook_secret = EXCLUDED.webhook_secret,
        custom_questions = EXCLUDED.custom_questions,
        branding = EXCLUDED.branding
      RETURNING *
    `, [whop_company_id, group_name, webhook_secret, JSON.stringify(custom_questions || []), JSON.stringify(branding || {})]);

    res.json({ success: true, group: result.rows[0] });
  } catch (error) {
    console.error('Error registering group:', error);
    res.status(500).json({ error: 'Failed to register group' });
  }
});

// Get member directory for a group
app.get('/api/directory/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { status = 'active' } = req.query;

    const result = await pool.query(`
      SELECT 
        id,
        whop_user_id,
        email,
        name,
        waitlist_responses,
        joined_at,
        status
      FROM members 
      WHERE whop_company_id = $1 AND status = $2
      ORDER BY joined_at DESC
    `, [companyId, status]);

    res.json({
      success: true,
      members: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching directory:', error);
    res.status(500).json({ error: 'Failed to fetch directory' });
  }
});

// Get group configuration
app.get('/api/group/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;

    const result = await pool.query(
      'SELECT * FROM groups WHERE whop_company_id = $1',
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    res.json({ success: true, group: result.rows[0] });
  } catch (error) {
    console.error('Error fetching group:', error);
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});

// Manual waitlist data submission endpoint
app.post('/api/waitlist/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { user_email, user_id, responses } = req.body;

    await pool.query(`
      INSERT INTO waitlist_responses (whop_company_id, user_email, user_id, responses, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `, [companyId, user_email, user_id, JSON.stringify(responses)]);

    res.json({ success: true, message: 'Waitlist response recorded' });
  } catch (error) {
    console.error('Error storing waitlist response:', error);
    res.status(500).json({ error: 'Failed to store waitlist response' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook endpoint: ${process.env.BASE_URL || 'http://localhost:' + PORT}/webhook/whop`);
  });
});

module.exports = app;
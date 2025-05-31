// server.js - Corrected implementation
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

// Whop API helper functions
async function fetchWhopUserData(userId, apiKey) {
  try {
    const response = await fetch(`https://api.whop.com/api/v2/users/${userId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Whop User API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching user data:', error);
    return null;
  }
}

async function fetchWhopMembershipData(membershipId, apiKey) {
  try {
    const response = await fetch(`https://api.whop.com/api/v2/memberships/${membershipId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Whop Membership API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching membership data:', error);
    return null;
  }
}

// Extract company ID from webhook payload
function extractCompanyId(webhookData) {
  return webhookData.data?.company_id || 
         webhookData.company_id || 
         webhookData.data?.product?.company_id ||
         webhookData.data?.membership?.company_id;
}

// Verify webhook signature
function verifyWebhookSignature(payload, signature, secret) {
  if (!signature || !secret) return false;
  
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const computedSignature = hmac.digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature.replace('sha256=', ''), 'hex'),
    Buffer.from(computedSignature, 'hex')
  );
}

// Initialize database tables
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // Groups table first
    await client.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        whop_company_id VARCHAR(255) UNIQUE NOT NULL,
        group_name VARCHAR(255) NOT NULL,
        webhook_secret VARCHAR(255),
        api_key VARCHAR(512),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Members table (removed problematic foreign key for now)
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        whop_company_id VARCHAR(255) NOT NULL,
        whop_user_id VARCHAR(255) NOT NULL,
        whop_membership_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255),
        username VARCHAR(255),
        name VARCHAR(255),
        profile_picture_url TEXT,
        waitlist_responses JSONB DEFAULT '{}',
        membership_data JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'active',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(whop_company_id, whop_user_id)
      )
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_company_id ON members(whop_company_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_user_id ON members(whop_user_id)
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  } finally {
    client.release();
  }
}

// Enhanced webhook handler
app.post('/webhook/whop', async (req, res) => {
  try {
    const webhookData = req.body;
    const companyId = extractCompanyId(webhookData);
    
    if (!companyId) {
      console.error('❌ No company ID found in webhook payload');
      return res.status(400).json({ error: 'Company ID required' });
    }

    console.log(`📍 Processing webhook for company: ${companyId}`);

    // Get group configuration
    const groupResult = await pool.query(
      'SELECT group_name, webhook_secret, api_key FROM groups WHERE whop_company_id = $1',
      [companyId]
    );

    if (groupResult.rows.length === 0) {
      console.log(`❌ Company ${companyId} not registered`);
      return res.status(404).json({ error: 'Company not registered' });
    }

    const { group_name, webhook_secret, api_key } = groupResult.rows[0];

    // Verify webhook signature (skip if no secret configured)
    if (webhook_secret) {
      const signature = req.headers['x-whop-signature'] || req.headers['whop-signature'];
      const payload = JSON.stringify(req.body);
      
      if (!verifyWebhookSignature(payload, signature, webhook_secret)) {
        console.error('❌ Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const eventType = webhookData.action || webhookData.type;
    const eventData = webhookData.data;

    console.log(`🎯 Processing event: ${eventType}`);

    if (eventType === 'membership.went_valid' || eventType === 'membership_went_valid') {
      await handleMembershipValid(eventData, companyId, api_key);
      
      res.status(200).json({ 
        success: true, 
        message: 'Member processed successfully',
        company: group_name
      });
      
    } else if (eventType === 'membership.went_invalid' || eventType === 'membership_went_invalid') {
      await handleMembershipInvalid(eventData, companyId);
      
      res.status(200).json({ 
        success: true, 
        message: 'Member deactivated successfully' 
      });
      
    } else {
      console.log(`ℹ️ Ignoring event type: ${eventType}`);
      res.status(200).json({ success: true, message: 'Event ignored' });
    }

  } catch (error) {
    console.error('💥 Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle membership becoming valid
async function handleMembershipValid(eventData, companyId, apiKey) {
  const userId = eventData.user_id || eventData.user?.id;
  const membershipId = eventData.id;

  if (!userId || !membershipId) {
    throw new Error('Missing user_id or membership_id in webhook data');
  }

  console.log(`📝 Processing member: ${userId}, membership: ${membershipId}`);

  // Fetch user data from Whop API
  const userData = await fetchWhopUserData(userId, apiKey);
  if (!userData) {
    throw new Error(`Failed to fetch user data for user_id: ${userId}`);
  }

  // Fetch membership data for custom fields
  const membershipData = await fetchWhopMembershipData(membershipId, apiKey);
  
  // Extract custom field responses
  let waitlistResponses = {};
  if (membershipData) {
    waitlistResponses = {
      ...membershipData.custom_fields_responses,
      ...membershipData.custom_fields_responses_v2
    };
  }

  // Store member in database
  const result = await pool.query(`
    INSERT INTO members (
      whop_company_id, 
      whop_user_id, 
      whop_membership_id,
      email, 
      username, 
      name, 
      profile_picture_url,
      waitlist_responses, 
      membership_data, 
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
    ON CONFLICT (whop_membership_id)
    DO UPDATE SET
      email = EXCLUDED.email,
      username = EXCLUDED.username,
      name = EXCLUDED.name,
      profile_picture_url = EXCLUDED.profile_picture_url,
      waitlist_responses = EXCLUDED.waitlist_responses,
      membership_data = EXCLUDED.membership_data,
      status = 'active',
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `, [
    companyId,
    userId,
    membershipId,
    userData.email,
    userData.username,
    userData.name || userData.display_name,
    userData.profile_picture_url,
    JSON.stringify(waitlistResponses),
    JSON.stringify(eventData)
  ]);

  console.log(`✅ Member ${userId} stored successfully (DB ID: ${result.rows[0].id})`);
  console.log(`📋 Waitlist responses: ${Object.keys(waitlistResponses).length} fields`);
  
  return result.rows[0];
}

// Handle membership becoming invalid
async function handleMembershipInvalid(eventData, companyId) {
  const userId = eventData.user_id || eventData.user?.id;
  const membershipId = eventData.id;

  await pool.query(
    'UPDATE members SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE whop_company_id = $2 AND (whop_user_id = $3 OR whop_membership_id = $4)',
    ['inactive', companyId, userId, membershipId]
  );

  console.log(`✅ Deactivated member ${userId} for company ${companyId}`);
}

// API Routes

// Register a new Whop group
app.post('/api/register-group', async (req, res) => {
  try {
    const { whop_company_id, group_name, webhook_secret, api_key } = req.body;

    if (!whop_company_id || !group_name) {
      return res.status(400).json({ 
        error: 'whop_company_id and group_name are required' 
      });
    }

    const result = await pool.query(`
      INSERT INTO groups (whop_company_id, group_name, webhook_secret, api_key)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (whop_company_id)
      DO UPDATE SET
        group_name = EXCLUDED.group_name,
        webhook_secret = EXCLUDED.webhook_secret,
        api_key = EXCLUDED.api_key
      RETURNING *
    `, [whop_company_id, group_name, webhook_secret, api_key]);

    console.log(`✅ Group registered: ${group_name}`);
    res.json({ success: true, group: result.rows[0] });
  } catch (error) {
    console.error('❌ Error registering group:', error);
    res.status(500).json({ error: 'Failed to register group' });
  }
});

// Get member directory
app.get('/api/directory/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { status = 'active' } = req.query;

    const result = await pool.query(`
      SELECT 
        id,
        whop_user_id,
        whop_membership_id,
        email,
        username,
        name,
        profile_picture_url,
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
      'SELECT whop_company_id, group_name, created_at FROM groups WHERE whop_company_id = $1',
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

// Manual sync member (force refresh from Whop API)
app.post('/api/sync-member/:companyId/:userId', async (req, res) => {
  try {
    const { companyId, userId } = req.params;

    // Get API key for this company
    const groupResult = await pool.query(
      'SELECT api_key FROM groups WHERE whop_company_id = $1',
      [companyId]
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const apiKey = groupResult.rows[0].api_key;
    if (!apiKey) {
      return res.status(400).json({ error: 'No API key configured for this company' });
    }

    // Fetch fresh user data
    const userData = await fetchWhopUserData(userId, apiKey);
    if (!userData) {
      return res.status(404).json({ error: 'User not found in Whop' });
    }

    // Update database
    const result = await pool.query(`
      UPDATE members 
      SET email = $1, username = $2, name = $3, profile_picture_url = $4, updated_at = CURRENT_TIMESTAMP
      WHERE whop_company_id = $5 AND whop_user_id = $6
      RETURNING *
    `, [
      userData.email,
      userData.username,
      userData.name || userData.display_name,
      userData.profile_picture_url,
      companyId,
      userId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in database' });
    }

    res.json({ success: true, member: result.rows[0] });
  } catch (error) {
    console.error('Error syncing member:', error);
    res.status(500).json({ error: 'Failed to sync member' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString()
  });
});

// Serve the directory page
app.get('/directory.html', (req, res) => {
  res.sendFile(__dirname + '/public/directory.html');
});

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Webhook endpoint: ${process.env.BASE_URL || 'http://localhost:' + PORT}/webhook/whop`);
    console.log(`🌐 Directory URL: ${process.env.BASE_URL || 'http://localhost:' + PORT}/directory.html?company=COMPANY_ID`);
  });
});

module.exports = app;
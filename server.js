// server.js - Native Whop App Implementation
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

// Middleware - IMPORTANT: Configure CORS for Whop iframe
app.use(cors({
  origin: ['https://whop.com', 'https://dash.whop.com', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Add CSP headers for iframe compatibility
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://whop.com https://dash.whop.com http://localhost:*");
  next();
});

// Initialize database tables
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    console.log('🔄 Initializing database...');
    
    // Members table with proper structure for custom fields
    await client.query(`
      CREATE TABLE IF NOT EXISTS whop_members (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        membership_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255),
        username VARCHAR(255),
        name VARCHAR(255),
        profile_picture_url TEXT,
        custom_fields JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'active',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(company_id, user_id)
      )
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_whop_members_company 
      ON whop_members(company_id)
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  } finally {
    client.release();
  }
}

// Webhook verification endpoint
app.get('/webhook/whop', (req, res) => {
  console.log('🔍 Webhook verification request received');
  res.status(200).json({ 
    status: 'ok', 
    message: 'Webhook endpoint is active',
    timestamp: new Date().toISOString()
  });
});

// Enhanced webhook handler for native Whop app
app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🔔 Webhook received:', JSON.stringify(req.body, null, 2));
    
    const { action, data } = req.body;
    
    // Verify webhook signature if secret is provided
    if (process.env.WHOP_WEBHOOK_SECRET) {
      const signature = req.headers['x-whop-signature'];
      const payload = JSON.stringify(req.body);
      const expectedSignature = crypto
        .createHmac('sha256', process.env.WHOP_WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');
      
      if (signature !== expectedSignature) {
        console.error('❌ Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    switch (action) {
      case 'membership.went_valid':
      case 'app_membership.went_valid':
        await handleMembershipValid(data);
        break;
        
      case 'membership.went_invalid':
      case 'app_membership.went_invalid':
        await handleMembershipInvalid(data);
        break;
        
      default:
        console.log(`ℹ️ Unhandled event type: ${action}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('💥 Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle membership becoming valid
async function handleMembershipValid(data) {
  try {
    const { user, id: membershipId, product } = data;
    const userId = user?.id || data.user_id;
    const companyId = product?.business_id || data.page_id || data.company_id;
    
    if (!userId || !membershipId || !companyId) {
      console.error('❌ Missing required fields');
      return;
    }

    console.log(`✅ Processing membership for user ${userId} in company ${companyId}`);

    // Extract custom fields from the webhook data
    let customFields = {};
    
    // Try different possible locations for custom field data
    if (data.custom_fields) {
      customFields = data.custom_fields;
    } else if (data.custom_field_responses) {
      customFields = data.custom_field_responses;
    } else if (data.metadata) {
      customFields = data.metadata;
    }
    
    // Also check for form_responses or checkout_custom_fields
    if (data.form_responses) {
      customFields = { ...customFields, ...data.form_responses };
    }
    if (data.checkout_custom_fields) {
      customFields = { ...customFields, ...data.checkout_custom_fields };
    }

    console.log('📋 Custom fields found:', customFields);

    // Store member in database
    await pool.query(`
      INSERT INTO whop_members (
        company_id, 
        user_id, 
        membership_id,
        email,
        username,
        name,
        profile_picture_url,
        custom_fields,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
      ON CONFLICT (membership_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        username = EXCLUDED.username,
        name = EXCLUDED.name,
        profile_picture_url = EXCLUDED.profile_picture_url,
        custom_fields = EXCLUDED.custom_fields,
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
    `, [
      companyId,
      userId,
      membershipId,
      user?.email || null,
      user?.username || null,
      user?.name || user?.display_name || null,
      user?.profile_pic_url || user?.profile_picture_url || null,
      JSON.stringify(customFields)
    ]);

    console.log(`✅ Member ${userId} stored successfully`);
  } catch (error) {
    console.error('❌ Error handling membership valid:', error);
  }
}

// Handle membership becoming invalid
async function handleMembershipInvalid(data) {
  try {
    const membershipId = data.id;
    
    await pool.query(
      'UPDATE whop_members SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE membership_id = $2',
      ['inactive', membershipId]
    );

    console.log(`✅ Deactivated membership ${membershipId}`);
  } catch (error) {
    console.error('❌ Error handling membership invalid:', error);
  }
}

// API endpoint to get members for a company
app.get('/api/directory/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { status = 'active' } = req.query;

    const result = await pool.query(`
      SELECT 
        id,
        user_id,
        membership_id,
        email,
        username,
        name,
        profile_picture_url,
        custom_fields,
        joined_at,
        status
      FROM whop_members 
      WHERE company_id = $1 AND status = $2
      ORDER BY joined_at DESC
    `, [companyId, status]);

    res.json({
      success: true,
      members: result.rows.map(member => ({
        ...member,
        waitlist_responses: member.custom_fields || {}
      })),
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching directory:', error);
    res.status(500).json({ error: 'Failed to fetch directory' });
  }
});

// Serve the native app directory page
app.get('/app', (req, res) => {
  res.sendFile(__dirname + '/public/app.html');
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    type: 'whop_native_app'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Whop Member Directory Native App',
    status: 'running',
    webhook_url: '/webhook/whop',
    app_url: '/app'
  });
});

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Native Whop App server running on port ${PORT}`);
    console.log(`📱 App URL: ${process.env.BASE_URL || 'http://localhost:' + PORT}/app`);
    console.log(`🔔 Webhook URL: ${process.env.BASE_URL || 'http://localhost:' + PORT}/webhook/whop`);
  });
}).catch(error => {
  console.error('💥 Failed to start server:', error);
  process.exit(1);
});
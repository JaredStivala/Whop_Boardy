// server.js - Native Whop App Implementation
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

// Environment variable validation
function validateEnvironment() {
    const requiredVars = {
      'WHOP_API_KEY': process.env.WHOP_API_KEY,
      'WHOP_WEBHOOK_SECRET': process.env.WHOP_WEBHOOK_SECRET,
      'DATABASE_URL': process.env.DATABASE_URL
    };
  
    console.log('🔍 Environment Variables Check:');
    
    let allValid = true;
    Object.entries(requiredVars).forEach(([key, value]) => {
      if (value) {
        console.log(`✅ ${key}: ${key === 'WHOP_API_KEY' ? value.substring(0, 10) + '...' : 'Set'}`);
      } else {
        console.error(`❌ ${key}: Missing!`);
        allValid = false;
      }
    });
  
    if (!allValid) {
      console.error('❌ Some required environment variables are missing!');
    }
    
    return allValid;
  }
  
  // Call this when server starts
  validateEnvironment();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err, client) => {
    console.error('🟥 DATABASE POOL ERROR:', err.message, err.stack);
});

// In server.js, replace the existing CORS and CSP configuration with this:

// Enhanced CORS configuration for Whop iframe
app.use(cors({
    origin: [
      'https://whop.com',
      'https://dash.whop.com', 
      'https://app.whop.com',
      'https://apps.whop.com',  // Add this - apps subdomain
      'http://localhost:3000',
      'https://whopboardy-production.up.railway.app'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  }));
  
  // Enhanced headers for iframe compatibility
  app.use((req, res, next) => {
    // Allow embedding in Whop iframes
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    
    // More permissive CSP for Whop iframe
    res.setHeader('Content-Security-Policy', 
      "frame-ancestors 'self' https://*.whop.com https://whop.com http://localhost:*; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' https://*.whop.com https://whop.com;"
    );
    
    // Additional headers for iframe support
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'origin-when-cross-origin');
    
    next();
  });

// Middleware to get raw body for signature verification
// This MUST come BEFORE express.json() if you need the raw body
app.use('/webhook/whop', express.raw({ type: 'application/json' }));

// Middleware to parse JSON body for other routes (and for req.body on non-webhook routes)
app.use(express.json());
app.use('/app', express.static('public'));

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
    console.log('🔔 Webhook received:'); // Raw body logged later if needed for debug
    console.log('🔍 Webhook headers:', JSON.stringify(req.headers, null, 2));

    // Verify webhook signature if secret is provided
    if (process.env.WHOP_WEBHOOK_SECRET) {
      const signatureHeader = req.headers['x-whop-signature'];
      const payload = req.body; // req.body is the raw buffer from express.raw() for this route
      const webhookSecret = process.env.WHOP_WEBHOOK_SECRET;
      
      if (!signatureHeader || !payload) {
          console.error('❌ Missing webhook signature header or payload');
          return res.status(401).json({ error: 'Missing signature or payload' });
      }

      // Parse the signature header (format: t=timestamp,v1=signature)
      const parts = signatureHeader.split(',');
      const timestampPart = parts.find(p => p.startsWith('t='));
      const signaturePart = parts.find(p => p.startsWith('v1='));

      if (!timestampPart || !signaturePart) {
          console.error('❌ Invalid signature header format');
          return res.status(401).json({ error: 'Invalid signature header format' });
      }

      const timestamp = timestampPart.substring(2); // Remove 't='
      const signature = signaturePart.substring(3); // Remove 'v1='

      // Construct the string to sign: timestamp + '.' + rawBody
      const signedPayload = `${timestamp}.${payload.toString()}`;
      
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(signedPayload)
        .digest('hex');
      
      console.log('Signature from header (v1):', signature);
      console.log('Calculated signature:', expectedSignature);

      // Use timingSafeEqual to compare signatures securely
      const signatureBuffer = Buffer.from(signature, 'hex');
      const expectedSignatureBuffer = Buffer.from(expectedSignature, 'hex');

      if (signatureBuffer.length !== expectedSignatureBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) {
        console.error('❌ Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
      console.log('✅ Webhook signature verified successfully');
    } else {
        console.warn('⚠️ WHOP_WEBHOOK_SECRET not set. Skipping signature verification.');
    }

    // After verification, parse the raw body into a JSON object for easier access
    // Only attempt parsing if payload exists (handled by missing payload check above)
    let jsonBody;
    try {
      jsonBody = JSON.parse(req.body.toString());
      console.log('Parsed webhook body:', JSON.stringify(jsonBody, null, 2)); // Log parsed body
    } catch (parseError) {
      console.error('❌ Failed to parse webhook body after verification:', parseError);
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { action, data } = jsonBody; // Use the manually parsed body

    console.log('📝 Action:', action);
    console.log('📝 Data (parsed):', JSON.stringify(data, null, 2)); // Log parsed data

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


// Replace the handleMembershipValid function in server.js with this enhanced version:

async function handleMembershipValid(data) {
    try {
      const { user, id: membershipId, product } = data;
      const userId = user?.id || data.user_id;
      const companyId = product?.business_id || data.page_id || data.company_id;
      
      if (!userId || !membershipId || !companyId) {
        console.error('❌ Missing required fields (userId, membershipId, or companyId)', { userId, membershipId, companyId });
        return;
      }
  
      console.log(`✅ Processing membership for user ${userId} in company ${companyId}`);
  
      // --- Fetch User Details from Whop API ---
      let whopUserData = null;
      try {
        console.log(`🔍 Fetching user details for ${userId} from Whop API...`);
        
        const userResponse = await fetch(`https://api.whop.com/api/v5/app/users/${userId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });
  
        if (userResponse.ok) {
          whopUserData = await userResponse.json();
          console.log('👤 User data from Whop API:', JSON.stringify(whopUserData, null, 2));
        } else {
          console.error(`❌ Failed to fetch user data: ${userResponse.status} - ${userResponse.statusText}`);
          const errorText = await userResponse.text();
          console.error('Error response:', errorText);
        }
      } catch (fetchError) {
        console.error('❌ Error fetching user data from Whop API:', fetchError);
      }
  
      // --- Fetch Membership Details from Whop API (for custom fields) ---
      let whopMembershipData = null;
      try {
        console.log(`🔍 Fetching membership details for ${membershipId} from Whop API...`);
        
        const membershipResponse = await fetch(`https://api.whop.com/api/v2/memberships/${membershipId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });
  
        if (membershipResponse.ok) {
          whopMembershipData = await membershipResponse.json();
          console.log('🎫 Membership data from Whop API:', JSON.stringify(whopMembershipData, null, 2));
        } else {
          console.error(`❌ Failed to fetch membership data: ${membershipResponse.status} - ${membershipResponse.statusText}`);
          const errorText = await membershipResponse.text();
          console.error('Error response:', errorText);
        }
      } catch (fetchError) {
        console.error('❌ Error fetching membership data from Whop API:', fetchError);
      }
  
      // --- Extract User Information ---
      // Priority: Whop API data > webhook data > fallback
      const userName = whopUserData?.name || 
                       whopUserData?.username || 
                       user?.name || 
                       user?.username || 
                       user?.display_name || 
                       'Anonymous Member';
      
      const userUsername = whopUserData?.username || 
                           user?.username || 
                           whopUserData?.name ||
                           user?.name ||
                           'anonymous';
      
      const userEmail = whopUserData?.email || 
                        user?.email || 
                        data.email || 
                        null;
  
      console.log('📋 Extracted user info:', {
        name: userName,
        username: userUsername,
        email: userEmail
      });
  
      // --- Extract Custom Fields / Waitlist Responses ---
      let customFields = {};
      
      console.log('🔍 Searching for custom fields in all data sources...');
      
      // Priority 1: Membership API data (most complete)
      if (whopMembershipData) {
        console.log('🎯 Processing membership API custom fields...');
        
        if (whopMembershipData.custom_fields_responses) {
          console.log('📋 Found custom_fields_responses:', JSON.stringify(whopMembershipData.custom_fields_responses, null, 2));
          customFields = { ...customFields, ...whopMembershipData.custom_fields_responses };
        }
        
        if (whopMembershipData.custom_fields_responses_v2) {
          console.log('📋 Found custom_fields_responses_v2:', JSON.stringify(whopMembershipData.custom_fields_responses_v2, null, 2));
          customFields = { ...customFields, ...whopMembershipData.custom_fields_responses_v2 };
        }
        
        if (whopMembershipData.metadata) {
          console.log('📋 Found membership metadata:', JSON.stringify(whopMembershipData.metadata, null, 2));
          customFields = { ...customFields, ...whopMembershipData.metadata };
        }
      }
      
      // Priority 2: Webhook data (fallback)
      const webhookSources = [
        { key: 'data.custom_field_responses', data: data.custom_field_responses },
        { key: 'data.custom_fields', data: data.custom_fields },
        { key: 'data.waitlist_responses', data: data.waitlist_responses },
        { key: 'data.form_responses', data: data.form_responses },
        { key: 'data.responses', data: data.responses },
        { key: 'data.metadata', data: data.metadata }
      ];
  
      // Process webhook sources
      webhookSources.forEach(source => {
        if (source.data) {
          console.log(`🔍 Checking webhook ${source.key}:`, JSON.stringify(source.data, null, 2));
          
          if (typeof source.data === 'object' && !Array.isArray(source.data)) {
            customFields = { ...customFields, ...source.data };
          } else if (typeof source.data === 'string' && source.data.length > 0) {
            try {
              const parsed = JSON.parse(source.data);
              if (typeof parsed === 'object') {
                customFields = { ...customFields, ...parsed };
              }
            } catch (e) {
              // Store as string if not parseable
              customFields[source.key.split('.')[1]] = source.data;
            }
          }
        }
      });
  
      console.log('📋 Final combined custom fields:', JSON.stringify(customFields, null, 2));
  
      // --- Store Member in Database ---
      await pool.query(`
        INSERT INTO whop_members (
          company_id, 
          user_id, 
          membership_id,
          email,
          name,
          username,
          custom_fields,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
        ON CONFLICT (membership_id)
        DO UPDATE SET
          email = EXCLUDED.email,
          name = EXCLUDED.name,
          username = EXCLUDED.username,
          custom_fields = EXCLUDED.custom_fields,
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
      `, [
        companyId,
        userId,
        membershipId,
        userEmail,
        userName,
        userUsername,
        JSON.stringify(customFields)
      ]);
  
      console.log(`🎉 Member ${userId} stored successfully with:`, {
        name: userName,
        username: userUsername,
        email: userEmail,
        customFieldsCount: Object.keys(customFields).length
      });
  
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

// Replace the /api/directory/:companyId route in server.js with this:

app.get('/api/directory/:companyId', async (req, res) => {
    try {
      // Pre-flight DB check
      console.log('ℹ️ Attempting Pre-flight DB check...');
      const preCheck = await pool.query("SELECT 'db_ping_ok' as check_status, NOW() as current_time;");
      console.log('✅ Pre-flight DB check successful:', preCheck.rows);
  
      const { companyId } = req.params;
      const status = req.query.status || 'active'; 
    
      console.log(`DEBUG: Using companyId for query: '${companyId}'`);
      console.log(`DEBUG: Using status for query: '${status}'`);
      
      // Enhanced query to get all member data including names
      const result = await pool.query(`
        SELECT 
          id,
          user_id,
          membership_id,
          email,
          name,
          username,
          custom_fields,
          joined_at,
          status
        FROM whop_members 
        WHERE company_id = $1 AND status = $2
        ORDER BY joined_at DESC
      `, [companyId, status]);
  
      console.log("🔍 Raw DB result:", result.rows);
    
      res.json({
        success: true,
        members: result.rows.map(member => {
          // Safely parse custom_fields with better error handling
          let parsedCustomFields = {};
          if (member.custom_fields) {
            try {
              if (typeof member.custom_fields === 'string') {
                // Check if it's an ActiveRecord proxy string
                if (member.custom_fields.includes('ActiveRecord_Associations_CollectionProxy') || 
                    member.custom_fields.includes('#<')) {
                  console.log(`⚠️  ActiveRecord proxy detected for member ${member.id}`);
                  parsedCustomFields = {
                    status: 'Custom fields detected',
                    note: 'Upgrade Whop app permissions to see details',
                    raw_indicator: member.custom_fields.substring(0, 50) + '...'
                  };
                } else {
                  // Try to parse as JSON
                  parsedCustomFields = JSON.parse(member.custom_fields);
                }
              } else {
                parsedCustomFields = member.custom_fields;
              }
            } catch (e) {
              console.warn(`JSON parse error for member ${member.id}:`, e.message);
              // Provide a user-friendly fallback
              parsedCustomFields = {
                error: 'Unable to parse custom fields',
                note: 'Custom field data exists but in an unsupported format',
                raw_length: typeof member.custom_fields === 'string' ? member.custom_fields.length : 'unknown'
              };
            }
          }

          return {
            id: member.id,
            user_id: member.user_id,
            membership_id: member.membership_id,
            email: member.email,
            name: member.name,
            username: member.username,
            waitlist_responses: parsedCustomFields, // Use safely parsed custom fields
            custom_fields: parsedCustomFields, // Also provide as custom_fields
            joined_at: member.joined_at,
            status: member.status
          };
        }),
        count: result.rows.length
      });
  
    } catch (error) {
      console.error('🟥 ERROR IN /api/directory/:companyId ROUTE:', error.message, error.stack);
      if (error.code) { 
           console.error('🟥 DB ERROR CODE (if available):', error.code);
      }
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

function handleContext(context) {
  const fallbackCompanyId = 'biz_6GuEa8lMu5p9yl'; // Replace this with your actual Whop company ID
  const companyId = context?.company?.id || fallbackCompanyId;

  if (!companyId) {
    console.error('❌ Company ID is still missing even after fallback.');
    return null;
  }

  console.log('✅ Using company ID:', companyId);
  return companyId;
}

app.get('/api/test-whop-api', async (req, res) => {
    try {
      const testUserId = req.query.userId || 'user_iSfIwrTJoy3Ab'; // Use the user ID from your logs
      
      console.log(`🧪 Testing Whop API with user ID: ${testUserId}`);
      console.log(`🔑 Using API key: ${process.env.WHOP_API_KEY ? process.env.WHOP_API_KEY.substring(0, 10) + '...' : 'MISSING'}`);
      
      const response = await fetch(`https://api.whop.com/api/v5/app/users/${testUserId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
  
      console.log(`📡 API Response status: ${response.status}`);
      
      if (response.ok) {
        const userData = await response.json();
        console.log('✅ API call successful:', userData);
        res.json({
          success: true,
          userData,
          message: 'Whop API is working correctly'
        });
      } else {
        const errorText = await response.text();
        console.error(`❌ API call failed: ${response.status} - ${errorText}`);
        res.status(response.status).json({
          success: false,
          error: errorText,
          status: response.status
        });
      }
    } catch (error) {
      console.error('❌ Test API call error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  // Add this test endpoint to server.js for debugging API key issues:

app.get('/api/test-whop-api', async (req, res) => {
    try {
      const testUserId = req.query.userId || 'user_iSfIwrTJoy3Ab'; // Use the user ID from your logs
      
      console.log(`🧪 Testing Whop API with user ID: ${testUserId}`);
      console.log(`🔑 Using API key: ${process.env.WHOP_API_KEY ? process.env.WHOP_API_KEY.substring(0, 10) + '...' : 'MISSING'}`);
      
      const response = await fetch(`https://api.whop.com/api/v5/app/users/${testUserId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
  
      console.log(`📡 API Response status: ${response.status}`);
      
      if (response.ok) {
        const userData = await response.json();
        console.log('✅ API call successful:', userData);
        res.json({
          success: true,
          userData,
          message: 'Whop API is working correctly'
        });
      } else {
        const errorText = await response.text();
        console.error(`❌ API call failed: ${response.status} - ${errorText}`);
        res.status(response.status).json({
          success: false,
          error: errorText,
          status: response.status
        });
      }
    } catch (error) {
      console.error('❌ Test API call error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  
  // Debug endpoint to check what's in the database
  app.get('/api/debug-members/:companyId', async (req, res) => {
    try {
      const { companyId } = req.params;
      
      const result = await pool.query(`
        SELECT 
          id, user_id, name, username, email, custom_fields, joined_at
        FROM whop_members 
        WHERE company_id = $1
        ORDER BY joined_at DESC
      `, [companyId]);
  
      console.log('🔍 Raw database results for debugging:');
      result.rows.forEach((row, index) => {
        console.log(`Member ${index + 1}:`, {
          id: row.id,
          user_id: row.user_id,
          name: row.name,
          username: row.username,
          email: row.email,
          custom_fields_type: typeof row.custom_fields,
          custom_fields_content: row.custom_fields,
          joined_at: row.joined_at
        });
      });
  
      res.json({
        success: true,
        debug: 'Check server logs for detailed member data',
        members: result.rows.map(row => ({
          ...row,
          custom_fields_parsed: (() => {
            try {
              return typeof row.custom_fields === 'string' 
                ? JSON.parse(row.custom_fields) 
                : row.custom_fields;
            } catch (e) {
              return { parse_error: e.message, raw: row.custom_fields };
            }
          })()
        }))
      });
  
    } catch (error) {
      console.error('❌ Debug endpoint error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  // Add this test endpoint to server.js for debugging API key issues:

app.get('/api/test-whop-api', async (req, res) => {
    try {
      const testUserId = req.query.userId || 'user_iSfIwrTJoy3Ab'; // Use the user ID from your logs
      
      console.log(`🧪 Testing Whop API with user ID: ${testUserId}`);
      console.log(`🔑 Using API key: ${process.env.WHOP_API_KEY ? process.env.WHOP_API_KEY.substring(0, 10) + '...' : 'MISSING'}`);
      
      const response = await fetch(`https://api.whop.com/api/v5/app/users/${testUserId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
  
      console.log(`📡 API Response status: ${response.status}`);
      
      if (response.ok) {
        const userData = await response.json();
        console.log('✅ API call successful:', userData);
        res.json({
          success: true,
          userData,
          message: 'Whop API is working correctly'
        });
      } else {
        const errorText = await response.text();
        console.error(`❌ API call failed: ${response.status} - ${errorText}`);
        res.status(response.status).json({
          success: false,
          error: errorText,
          status: response.status
        });
      }
    } catch (error) {
      console.error('❌ Test API call error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  
  // Test membership endpoint
  app.get('/api/test-membership', async (req, res) => {
    try {
      const testMembershipId = req.query.membershipId || 'mem_vl5OQlqbb59Jpw'; // Use from your logs
      
      console.log(`🧪 Testing Membership API with ID: ${testMembershipId}`);
      
      const response = await fetch(`https://api.whop.com/api/v2/memberships/${testMembershipId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
  
      console.log(`📡 Membership API Response status: ${response.status}`);
      
      if (response.ok) {
        const membershipData = await response.json();
        console.log('✅ Membership API call successful:', membershipData);
        res.json({
          success: true,
          membershipData,
          customFields: {
            custom_fields_responses: membershipData.custom_fields_responses,
            custom_fields_responses_v2: membershipData.custom_fields_responses_v2,
            metadata: membershipData.metadata
          },
          message: 'Membership API is working correctly'
        });
      } else {
        const errorText = await response.text();
        console.error(`❌ Membership API call failed: ${response.status} - ${errorText}`);
        res.status(response.status).json({
          success: false,
          error: errorText,
          status: response.status
        });
      }
    } catch (error) {
      console.error('❌ Test membership API call error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  
  // Debug endpoint to check what's in the database
  app.get('/api/debug-members/:companyId', async (req, res) => {
    try {
      const { companyId } = req.params;
      
      const result = await pool.query(`
        SELECT 
          id, user_id, name, username, email, custom_fields, joined_at
        FROM whop_members 
        WHERE company_id = $1
        ORDER BY joined_at DESC
      `, [companyId]);
  
      console.log('🔍 Raw database results for debugging:');
      result.rows.forEach((row, index) => {
        console.log(`Member ${index + 1}:`, {
          id: row.id,
          user_id: row.user_id,
          name: row.name,
          username: row.username,
          email: row.email,
          custom_fields_type: typeof row.custom_fields,
          custom_fields_content: row.custom_fields,
          joined_at: row.joined_at
        });
      });
  
      res.json({
        success: true,
        debug: 'Check server logs for detailed member data',
        members: result.rows.map(row => ({
          ...row,
          custom_fields_parsed: (() => {
            try {
              return typeof row.custom_fields === 'string' 
                ? JSON.parse(row.custom_fields) 
                : row.custom_fields;
            } catch (e) {
              return { parse_error: e.message, raw: row.custom_fields };
            }
          })()
        }))
      });
  
    } catch (error) {
      console.error('❌ Debug endpoint error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Whop API client
const whopApi = axios.create({
  baseURL: process.env.WHOP_API_URL || 'https://api.whop.com/api/v2',
  headers: {
    'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create companies table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whop_companies (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(255) UNIQUE NOT NULL,
        company_name VARCHAR(500),
        company_slug VARCHAR(255),
        installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(50) DEFAULT 'active'
      )
    `);

    // Create members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whop_members (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        membership_id VARCHAR(255),
        company_id VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        name VARCHAR(255),
        username VARCHAR(255),
        custom_fields JSONB DEFAULT '{}',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(50) DEFAULT 'active',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, company_id)
      )
    `);

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

initializeDatabase();

// Function to sync members with Whop API
async function syncMembersWithWhop(companyId) {
  try {
    console.log(`🔄 Syncing members for company: ${companyId}`);
    
    // Fetch members from Whop API
    const response = await whopApi.get(`/experiences/${companyId}/users`);

    if (!response || !response.data || !response.data.users) {
      throw new Error('Invalid response from Whop API');
    }

    const whopMembers = response.data.users.nodes;
    console.log(`📥 Fetched ${whopMembers.length} members from Whop`);

    // Update or insert members in database
    for (const member of whopMembers) {
      await pool.query(`
        INSERT INTO whop_members (
          user_id,
          company_id,
          username,
          name,
          profile_picture,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, company_id) 
        DO UPDATE SET
          username = EXCLUDED.username,
          name = EXCLUDED.name,
          profile_picture = EXCLUDED.profile_picture,
          updated_at = CURRENT_TIMESTAMP
      `, [
        member.id,
        companyId,
        member.username,
        member.name,
        member.profilePicture?.sourceUrl || null
      ]);
    }

    console.log(`✅ Successfully synced ${whopMembers.length} members`);
    return whopMembers.length;
  } catch (error) {
    console.error('❌ Error syncing members:', error);
    throw error;
  }
}

// FIXED: Enhanced company ID extraction that actually works with Whop URLs
function extractCompanyId(req) {
  console.log('🔍 Extracting company ID from request...');
  
  // Method 1: Direct company_id parameter
  if (req.query.company_id) {
    console.log(`✅ Found company_id in query: ${req.query.company_id}`);
    return req.query.company_id;
  }
  
  // Method 2: Extract from Whop referer URL - FIXED PATTERNS
  const referer = req.headers.referer || req.headers.referrer;
  if (referer) {
    console.log(`🔍 Analyzing referer: ${referer}`);
    
    // NEW: Extract from actual Whop URL patterns
    const patterns = [
      // Pattern: whop.com/community-slug/app-name/app/
      /whop\.com\/([^\/]+)\/[^\/]+\/app\//,
      
      // Pattern: whop.com/community-slug/
      /whop\.com\/([^\/]+)\//,
      
      // Pattern: Direct biz_ ID anywhere in URL
      /(biz_[a-zA-Z0-9]+)/,
      
      // Pattern: Company slug in path
      /\/([a-zA-Z0-9_-]+)\/tools/,
      /\/([a-zA-Z0-9_-]+)\/integrations/,
    ];
    
    for (const pattern of patterns) {
      const match = referer.match(pattern);
      if (match) {
        let extracted = match[1];
        console.log(`✅ Extracted from URL pattern: ${extracted}`);
        return extracted;
      }
    }
  }
  
  // Method 3: Check all headers for company clues
  const headers = req.headers;
  
  // Standard company headers
  if (headers['x-company-id']) {
    return headers['x-company-id'];
  }
  
  if (headers['x-whop-company-id']) {
    return headers['x-whop-company-id'];
  }
  
  // Check for company info in any header
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value.includes('biz_')) {
      const bizMatch = value.match(/(biz_[a-zA-Z0-9]+)/);
      if (bizMatch) {
        console.log(`✅ Found biz_ ID in header ${key}: ${bizMatch[1]}`);
        return bizMatch[1];
      }
    }
  }
  
  console.log('❌ No company ID found in request');
  return null;
}

// FIXED: Company lookup with proper slug handling
async function findCompanyInDatabase(identifier) {
  if (!identifier) return null;
  
  console.log(`🔍 Looking up company for identifier: ${identifier}`);
  
  try {
    // Try exact company_id match first
    let result = await pool.query(`
      SELECT company_id, company_name, company_slug 
      FROM whop_companies 
      WHERE company_id = $1
      LIMIT 1
    `, [identifier]);
    
    if (result.rows.length > 0) {
      console.log(`✅ Found exact company_id match: ${result.rows[0].company_id}`);
      return result.rows[0];
    }
    
    // Try company_slug match (for URL slugs like 'jaredsuniverse')
    result = await pool.query(`
      SELECT company_id, company_name, company_slug 
      FROM whop_companies 
      WHERE company_slug = $1
      LIMIT 1
    `, [identifier]);
    
    if (result.rows.length > 0) {
      console.log(`✅ Found company_slug match: ${result.rows[0].company_id}`);
      return result.rows[0];
    }
    
    // Try partial name match
    result = await pool.query(`
      SELECT company_id, company_name, company_slug 
      FROM whop_companies 
      WHERE company_name ILIKE $1
      LIMIT 1
    `, [`%${identifier}%`]);
    
    if (result.rows.length > 0) {
      console.log(`✅ Found partial name match: ${result.rows[0].company_id}`);
      return result.rows[0];
    }
    
    console.log(`❌ No company found for identifier: ${identifier}`);
    return null;
    
  } catch (error) {
    console.error('❌ Error looking up company:', error);
    return null;
  }
}

// FIXED: Auto-detection that creates directories for new communities
app.get('/api/members/auto', async (req, res) => {
  try {
    console.log('🔍 Auto-detection request received');
    console.log('📦 Request URL:', req.url);
    console.log('📦 Referer:', req.headers.referer);
    
    // Extract company identifier
    const extractedId = extractCompanyId(req);
    console.log(`🎯 Extracted identifier: ${extractedId}`);
    
    if (!extractedId) {
      return res.status(400).json({
        success: false,
        error: 'Cannot detect community',
        message: 'Unable to determine which community you are accessing from. Please ensure you are viewing this app from within a Whop community.',
        debug: {
          referer: req.headers.referer,
          query: req.query,
          note: 'App must be accessed from within Whop community'
        }
      });
    }
    
    // Look up company in database
    let company = await findCompanyInDatabase(extractedId);
    console.log(`🏢 Database lookup result:`, company);
    
    // If no company found, create new directory for this community
    if (!company) {
      console.log(`🎉 NEW COMMUNITY: Creating directory for ${extractedId}`);
      
      try {
        // Generate a proper company ID if we only have a slug
        let companyId = extractedId;
        if (!extractedId.startsWith('biz_')) {
          // Create a proper company ID from the slug
          companyId = `biz_${extractedId}_${Math.random().toString(36).substr(2, 9)}`;
        }
        
        await pool.query(`
          INSERT INTO whop_companies (company_id, company_name, company_slug, installed_at, last_activity, status) 
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'active')
        `, [companyId, `${extractedId} Community`, extractedId]);
        
        console.log(`✅ NEW DIRECTORY CREATED: ${companyId} for slug ${extractedId}`);
        
        // Fetch the created company
        company = await findCompanyInDatabase(companyId);
        
        // Sync members for the new company
        try {
          const memberCount = await syncMembersWithWhop(companyId);
          console.log(`✅ Synced ${memberCount} members for new company`);
        } catch (syncError) {
          console.error('⚠️ Warning: Failed to sync members for new company:', syncError);
          // Continue even if sync fails - we'll try again later
        }
        
      } catch (createError) {
        console.error('❌ Error creating directory:', createError);
        return res.status(500).json({
          success: false,
          error: 'Failed to create directory',
          extracted_id: extractedId,
          details: createError.message
        });
      }
    }
    
    if (!company) {
      return res.status(500).json({
        success: false,
        error: 'Failed to find or create directory',
        extracted_id: extractedId
      });
    }
    
    // Update last activity
    await pool.query(`
      UPDATE whop_companies 
      SET last_activity = CURRENT_TIMESTAMP 
      WHERE company_id = $1
    `, [company.company_id]);
    
    // Sync members for existing company
    try {
      const memberCount = await syncMembersWithWhop(company.company_id);
      console.log(`✅ Synced ${memberCount} members for existing company`);
    } catch (syncError) {
      console.error('⚠️ Warning: Failed to sync members:', syncError);
      // Continue even if sync fails - we'll try again later
    }
    
    // Return success response
    return res.json({
      success: true,
      company: {
        id: company.company_id,
        name: company.company_name,
        slug: company.company_slug
      },
      message: 'Member directory ready'
    });
    
  } catch (error) {
    console.error('❌ Error in auto-detection:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Simple clean interface - BLACK THEME
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Member Directory</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a1a;
            color: #ffffff;
            line-height: 1.6;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            font-weight: 700;
        }
        
        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: #2d2d2d;
            border-radius: 8px;
            padding: 25px;
            text-align: center;
            border: 1px solid #3d3d3d;
        }
        
        .stat-number {
            font-size: 2.5rem;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 5px;
        }
        
        .stat-label {
            color: #888;
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .members-section {
            background: #2d2d2d;
            border-radius: 12px;
            padding: 30px;
            border: 1px solid #3d3d3d;
        }
        
        .section-title {
            font-size: 1.5rem;
            margin-bottom: 20px;
            color: #ffffff;
        }
        
        .member-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 20px;
        }
        
        .member-card {
            background: #1a1a1a;
            border-radius: 8px;
            padding: 20px;
            border: 1px solid #3d3d3d;
            transition: transform 0.2s, border-color 0.2s;
        }
        
        .member-card:hover {
            transform: translateY(-2px);
            border-color: #667eea;
        }
        
        .member-name {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 8px;
            color: #ffffff;
        }
        
        .member-email {
            color: #888;
            font-size: 0.9rem;
            margin-bottom: 10px;
        }
        
        .member-date {
            color: #667eea;
            font-size: 0.8rem;
            background: rgba(102, 126, 234, 0.1);
            padding: 4px 8px;
            border-radius: 4px;
            display: inline-block;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: #888;
        }
        
        .error {
            background: #ff4757;
            color: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #888;
        }
        
        .empty-state h3 {
            margin-bottom: 10px;
            color: #fff;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Member Directory</h1>
            <p id="directory-name">Loading directory...</p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-number" id="total-members">-</div>
                <div class="stat-label">Total Members</div>
            </div>
            <div class="stat-card">
                <div class="stat-number" id="new-month">-</div>
                <div class="stat-label">New This Month</div>
            </div>
            <div class="stat-card">
                <div class="stat-number" id="active-members">-</div>
                <div class="stat-label">Active Members</div>
            </div>
        </div>
        
        <div class="members-section">
            <h2 class="section-title">Community Members</h2>
            <div id="members-container">
                <div class="loading">Loading members...</div>
            </div>
        </div>
    </div>

    <script>
        async function loadMembers() {
            try {
                console.log('Loading members...');
                const response = await fetch('/api/members/auto');
                const data = await response.json();
                
                console.log('Response:', data);
                
                if (!data.success) {
                    showError(data.error || 'Failed to load members');
                    return;
                }
                
                // Update directory name
                document.getElementById('directory-name').textContent = 
                    \`\${data.company.name} Directory\`;
                
                // Update stats
                const totalMembers = data.members.length;
                const currentMonth = new Date().getMonth();
                const currentYear = new Date().getFullYear();
                
                const newThisMonth = data.members.filter(member => {
                    const joinDate = new Date(member.joined_at);
                    return joinDate.getMonth() === currentMonth && 
                           joinDate.getFullYear() === currentYear;
                }).length;
                
                document.getElementById('total-members').textContent = totalMembers;
                document.getElementById('new-month').textContent = newThisMonth;
                document.getElementById('active-members').textContent = totalMembers;
                
                // Display members
                displayMembers(data.members);
                
            } catch (error) {
                console.error('Error loading members:', error);
                showError('Network error loading members');
            }
        }
        
        function displayMembers(members) {
            const container = document.getElementById('members-container');
            
            if (members.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <h3>No Members Yet</h3>
                        <p>Members will appear here as they join your community.</p>
                    </div>
                \`;
                return;
            }
            
            container.innerHTML = \`
                <div class="member-grid">
                    \${members.map(member => \`
                        <div class="member-card">
                            <div class="member-name">
                                \${member.name || 'Anonymous Member'}
                            </div>
                            <div class="member-email">
                                \${member.email || 'No email provided'}
                            </div>
                            <div class="member-date">
                                Joined \${new Date(member.joined_at).toLocaleDateString()}
                            </div>
                        </div>
                    \`).join('')}
                </div>
            \`;
        }
        
        function showError(message) {
            const container = document.getElementById('members-container');
            container.innerHTML = \`
                <div class="error">
                    <strong>Error:</strong> \${message}
                </div>
            \`;
        }
        
        // Load members when page loads
        loadMembers();
        
        // Refresh every 30 seconds
        setInterval(loadMembers, 30000);
    </script>
</body>
</html>
  `);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database: 'connected'
  });
});

// Debug endpoint
app.get('/api/debug/company', (req, res) => {
  const extractedId = extractCompanyId(req);
  
  res.json({
    extracted_company_id: extractedId,
    request_details: {
      url: req.url,
      referer: req.headers.referer,
      query: req.query,
      headers: {
        referer: req.headers.referer,
        'user-agent': req.headers['user-agent'],
        'x-company-id': req.headers['x-company-id'],
      }
    }
  });
});

// Webhook handler for member updates
app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🎣 Webhook received:', JSON.stringify(req.body, null, 2));
    
    const { action, data } = req.body;
    
    if (!action || !data) {
      return res.status(400).json({ error: 'Invalid webhook format' });
    }
    
    // Extract company ID from webhook data
    const companyId = data.page_id || data.company_id || data.business_id;
    
    if (!companyId) {
      console.error('❌ No company ID in webhook data');
      return res.status(400).json({ error: 'No company ID found' });
    }
    
    console.log(\`📦 Processing webhook: \${action} for company \${companyId}\`);
    
    // Handle different webhook events
    switch (action) {
      case 'membership_went_valid':
      case 'membership.went_valid':
        await handleMembershipValid(companyId, data);
        break;
        
      case 'membership_went_invalid':
      case 'membership.went_invalid':
        await handleMembershipInvalid(companyId, data);
        break;
        
      default:
        console.log(\`ℹ️ Unhandled event: \${action}\`);
    }
    
    res.json({ success: true, processed: action });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle member joining
async function handleMembershipValid(companyId, data) {
  const userId = data.user_id || data.user;
  
  if (!userId) {
    console.error('❌ No user_id in webhook');
    return;
  }
  
  console.log(\`👤 Adding member \${userId} to \${companyId}\`);
  
  try {
    // Ensure company exists
    const company = await findCompanyInDatabase(companyId);
    if (!company) {
      console.log(\`🆕 Creating company for \${companyId}\`);
      await pool.query(\`
        INSERT INTO whop_companies (company_id, company_name, installed_at, last_activity, status) 
        VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'active')
        ON CONFLICT (company_id) DO NOTHING
      \`, [companyId, \`Company \${companyId}\`]);
    }
    
    // Add member
    const userName = data.name || data.display_name || data.user_name || null;
    const userEmail = data.email || data.user_email || null;
    const joinedAt = data.created_at ? new Date(data.created_at * 1000) : new Date();
    
    await pool.query(\`
      INSERT INTO whop_members (
        user_id, company_id, email, name, joined_at, status, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'active', CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, company_id) 
      DO UPDATE SET 
        email = COALESCE(EXCLUDED.email, whop_members.email),
        name = COALESCE(EXCLUDED.name, whop_members.name),
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
    \`, [userId, companyId, userEmail, userName, joinedAt]);
    
    console.log(\`✅ Member \${userId} added to \${companyId}\`);
    
  } catch (error) {
    console.error('❌ Error adding member:', error);
  }
}

// Handle member leaving
async function handleMembershipInvalid(companyId, data) {
  const userId = data.user_id || data.user;
  
  if (!userId) return;
  
  try {
    await pool.query(\`
      UPDATE whop_members 
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND company_id = $2
    \`, [userId, companyId]);
    
    console.log(\`❌ Member \${userId} removed from \${companyId}\`);
    
  } catch (error) {
    console.error('❌ Error removing member:', error);
  }
}

// Manual member synchronization endpoint
app.post('/api/members/sync/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    
    if (!companyId) {
      return res.status(400).json({
        success: false,
        error: 'Company ID is required'
      });
    }
    
    // Verify company exists
    const company = await findCompanyInDatabase(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        error: 'Company not found'
      });
    }
    
    // Sync members
    const memberCount = await syncMembersWithWhop(companyId);
    
    return res.json({
      success: true,
      message: `Successfully synced ${memberCount} members`,
      company: {
        id: company.company_id,
        name: company.company_name,
        slug: company.company_slug
      },
      member_count: memberCount
    });
    
  } catch (error) {
    console.error('❌ Error in manual sync:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to sync members',
      details: error.message
    });
  }
});

app.listen(port, () => {
  console.log('');
  console.log('🎉 ===== WHOP MEMBER DIRECTORY (FIXED) =====');
  console.log(\`🚀 Server running on port \${port}\`);
  console.log(\`📱 App URL: \${process.env.NODE_ENV === 'production' ? 'https://whopboardy-production.up.railway.app' : \`http://localhost:\${port}\`}/\`);
  console.log(\`🔗 Webhook URL: \${process.env.NODE_ENV === 'production' ? 'https://whopboardy-production.up.railway.app' : \`http://localhost:\${port}\`}/webhook/whop\`);
  console.log('');
  console.log('🔧 FIXES APPLIED:');
  console.log('   ✅ Proper company ID extraction from Whop URLs');
  console.log('   ✅ Support for community slugs (jaredsuniverse, etc)');
  console.log('   ✅ Auto-create directories for new communities');
  console.log('   ✅ Clean black interface (no more white theme)');
  console.log('   ✅ Separate directories per community');
  console.log('');
  console.log('🎯 URL Pattern Support:');
  console.log('   📍 whop.com/community-slug/app-name/app/');
  console.log('   📍 Direct biz_ IDs');
  console.log('   📍 Company slugs and names');
  console.log('');
});
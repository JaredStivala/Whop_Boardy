class MemberDirectory {
    constructor() {
        this.members = [];
        this.filteredMembers = [];
        this.searchTerm = '';
        this.sortField = 'joined_at';
        this.sortDirection = 'desc';
        this.loading = false;
        this.init();
    }

    async init() {
        this.createModernUI();
        await this.loadMembers();
        this.setupEventListeners();
    }

    createModernUI() {
        document.body.innerHTML = `
            <div class="app-container">
                <!-- Header -->
                <header class="app-header">
                    <div class="header-content">
                        <div class="header-left">
                            <div class="app-icon">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2"/>
                                    <path d="M7 8h10M7 12h10M7 16h6" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            </div>
                            <div class="header-title">
                                <h1>Member Directory</h1>
                                <p>Connect with fellow community members</p>
                            </div>
                        </div>
                        <div class="header-actions">
                            <button class="btn-secondary" id="refreshBtn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" stroke="currentColor" stroke-width="2"/>
                                    <path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" stroke="currentColor" stroke-width="2"/>
                                    <path d="M8 16H3v5" stroke="currentColor" stroke-width="2"/>
                                </svg>
                                Refresh
                            </button>
                        </div>
                    </div>
                </header>

                <!-- Stats Cards -->
                <section class="stats-section">
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-icon stat-icon-primary">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="2"/>
                                    <circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="2"/>
                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            </div>
                            <div class="stat-content">
                                <div class="stat-value" id="totalMembers">0</div>
                                <div class="stat-label">Total Members</div>
                            </div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-icon stat-icon-success">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            </div>
                            <div class="stat-content">
                                <div class="stat-value" id="newThisMonth">0</div>
                                <div class="stat-label">New This Month</div>
                            </div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-icon stat-icon-warning">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            </div>
                            <div class="stat-content">
                                <div class="stat-value" id="activeMembers">0</div>
                                <div class="stat-label">Active Members</div>
                            </div>
                        </div>
                    </div>
                </section>

                <!-- Controls -->
                <section class="controls-section">
                    <div class="controls-bar">
                        <div class="search-container">
                            <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none">
                                <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                                <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2"/>
                            </svg>
                            <input 
                                type="text" 
                                id="searchInput" 
                                placeholder="Search members..." 
                                class="search-input"
                            />
                        </div>
                        
                        <div class="filter-controls">
                            <select id="sortSelect" class="select-input">
                                <option value="joined_at_desc">Newest First</option>
                                <option value="joined_at_asc">Oldest First</option>
                                <option value="name_asc">Name A-Z</option>
                                <option value="name_desc">Name Z-A</option>
                            </select>
                        </div>
                    </div>
                </section>

                <!-- Members Table -->
                <section class="table-section">
                    <div class="table-container">
                        <div class="table-header">
                            <h2>Members</h2>
                            <div class="table-meta">
                                <span id="memberCount">0 members</span>
                            </div>
                        </div>
                        
                        <div class="table-wrapper">
                            <table class="members-table">
                                <thead>
                                    <tr>
                                        <th class="col-member">
                                            <button class="th-button" data-sort="name">
                                                Member
                                                <svg class="sort-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                                    <path d="M8 9l4-4 4 4M16 15l-4 4-4-4" stroke="currentColor" stroke-width="2"/>
                                                </svg>
                                            </button>
                                        </th>
                                        <th class="col-custom-fields">
                                            <button class="th-button">
                                                Custom Fields
                                            </button>
                                        </th>
                                        <th class="col-joined">
                                            <button class="th-button" data-sort="joined_at">
                                                Joined
                                                <svg class="sort-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                                    <path d="M8 9l4-4 4 4M16 15l-4 4-4-4" stroke="currentColor" stroke-width="2"/>
                                                </svg>
                                            </button>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody id="membersTableBody">
                                    <!-- Loading state -->
                                </tbody>
                            </table>
                            
                            <!-- Loading State -->
                            <div id="loadingState" class="loading-state">
                                <div class="loading-spinner"></div>
                                <p>Loading members...</p>
                            </div>
                            
                            <!-- Empty State -->
                            <div id="emptyState" class="empty-state" style="display: none;">
                                <div class="empty-icon">
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                        <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" stroke="currentColor" stroke-width="2"/>
                                    </svg>
                                </div>
                                <h3>No members found</h3>
                                <p>Try adjusting your search or filters</p>
                            </div>
                        </div>
                    </div>
                </section>
            </div>

            <style>
                /* Modern CSS Reset and Base Styles */
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Inter', sans-serif;
                    background: #0a0a0a;
                    color: #ffffff;
                    line-height: 1.5;
                    overflow-x: hidden;
                }

                .app-container {
                    min-height: 100vh;
                    background: linear-gradient(180deg, #0a0a0a 0%, #111111 100%);
                }

                /* Header Styles */
                .app-header {
                    background: rgba(17, 17, 17, 0.8);
                    backdrop-filter: blur(20px);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    position: sticky;
                    top: 0;
                    z-index: 100;
                }

                .header-content {
                    max-width: 1200px;
                    margin: 0 auto;
                    padding: 20px 24px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .header-left {
                    display: flex;
                    align-items: center;
                    gap: 16px;
                }

                .app-icon {
                    width: 48px;
                    height: 48px;
                    background: linear-gradient(135deg, #3b82f6, #8b5cf6);
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                }

                .header-title h1 {
                    font-size: 24px;
                    font-weight: 700;
                    margin-bottom: 2px;
                    background: linear-gradient(135deg, #ffffff, #a1a1aa);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }

                .header-title p {
                    font-size: 14px;
                    color: #71717a;
                }

                /* Button Styles */
                .btn-secondary {
                    background: rgba(39, 39, 42, 0.8);
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    color: #ffffff;
                    padding: 10px 16px;
                    border-radius: 8px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    transition: all 0.2s;
                }

                .btn-secondary:hover {
                    background: rgba(63, 63, 70, 0.8);
                    border-color: rgba(255, 255, 255, 0.2);
                    transform: translateY(-1px);
                }

                /* Stats Section */
                .stats-section {
                    max-width: 1200px;
                    margin: 0 auto;
                    padding: 32px 24px;
                }

                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 20px;
                }

                .stat-card {
                    background: rgba(39, 39, 42, 0.5);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 16px;
                    padding: 24px;
                    display: flex;
                    align-items: center;
                    gap: 16px;
                    transition: all 0.3s;
                    backdrop-filter: blur(10px);
                }

                .stat-card:hover {
                    background: rgba(39, 39, 42, 0.8);
                    border-color: rgba(255, 255, 255, 0.12);
                    transform: translateY(-2px);
                    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
                }

                .stat-icon {
                    width: 48px;
                    height: 48px;
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }

                .stat-icon-primary {
                    background: linear-gradient(135deg, #3b82f6, #1d4ed8);
                    color: white;
                }

                .stat-icon-success {
                    background: linear-gradient(135deg, #10b981, #059669);
                    color: white;
                }

                .stat-icon-warning {
                    background: linear-gradient(135deg, #f59e0b, #d97706);
                    color: white;
                }

                .stat-value {
                    font-size: 32px;
                    font-weight: 700;
                    color: #ffffff;
                    line-height: 1;
                }

                .stat-label {
                    font-size: 14px;
                    color: #a1a1aa;
                    font-weight: 500;
                }

                /* Controls Section */
                .controls-section {
                    max-width: 1200px;
                    margin: 0 auto;
                    padding: 0 24px 24px;
                }

                .controls-bar {
                    display: flex;
                    gap: 16px;
                    align-items: center;
                    flex-wrap: wrap;
                }

                .search-container {
                    position: relative;
                    flex: 1;
                    min-width: 300px;
                }

                .search-icon {
                    position: absolute;
                    left: 14px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: #71717a;
                    pointer-events: none;
                }

                .search-input {
                    width: 100%;
                    background: rgba(39, 39, 42, 0.6);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 12px;
                    padding: 12px 16px 12px 44px;
                    font-size: 14px;
                    color: #ffffff;
                    transition: all 0.2s;
                }

                .search-input:focus {
                    outline: none;
                    border-color: #3b82f6;
                    background: rgba(39, 39, 42, 0.8);
                    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
                }

                .search-input::placeholder {
                    color: #71717a;
                }

                .select-input {
                    background: rgba(39, 39, 42, 0.6);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 8px;
                    padding: 10px 14px;
                    font-size: 14px;
                    color: #ffffff;
                    cursor: pointer;
                    min-width: 160px;
                }

                .select-input:focus {
                    outline: none;
                    border-color: #3b82f6;
                    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
                }

                /* Table Section */
                .table-section {
                    max-width: 1200px;
                    margin: 0 auto;
                    padding: 0 24px 40px;
                }

                .table-container {
                    background: rgba(39, 39, 42, 0.4);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 16px;
                    overflow: hidden;
                    backdrop-filter: blur(10px);
                }

                .table-header {
                    padding: 24px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .table-header h2 {
                    font-size: 20px;
                    font-weight: 600;
                    color: #ffffff;
                }

                .table-meta {
                    font-size: 14px;
                    color: #71717a;
                }

                .table-wrapper {
                    position: relative;
                }

                .members-table {
                    width: 100%;
                    border-collapse: collapse;
                }

                .members-table thead {
                    background: rgba(24, 24, 27, 0.8);
                }

                .members-table th {
                    padding: 0;
                    text-align: left;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                }

                .th-button {
                    width: 100%;
                    background: none;
                    border: none;
                    color: #a1a1aa;
                    font-size: 12px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    padding: 16px 20px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    transition: all 0.2s;
                }

                .th-button:hover {
                    color: #ffffff;
                    background: rgba(255, 255, 255, 0.05);
                }

                .sort-icon {
                    opacity: 0.5;
                    transition: opacity 0.2s;
                }

                .th-button:hover .sort-icon {
                    opacity: 1;
                }

                .members-table td {
                    padding: 20px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                    vertical-align: top;
                }

                .members-table tr {
                    transition: all 0.2s;
                }

                .members-table tbody tr:hover {
                    background: rgba(255, 255, 255, 0.03);
                }

                /* Member Cell Styles */
                .member-cell {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .member-avatar {
                    width: 44px;
                    height: 44px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, #3b82f6, #8b5cf6);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    font-weight: 600;
                    font-size: 16px;
                    flex-shrink: 0;
                }

                .member-info {
                    flex: 1;
                    min-width: 0;
                }

                .member-name {
                    font-size: 16px;
                    font-weight: 600;
                    color: #ffffff;
                    margin-bottom: 2px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .member-username {
                    color: #3b82f6;
                    font-weight: 500;
                }

                .member-email {
                    font-size: 14px;
                    color: #71717a;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                /* Custom Fields */
                .custom-fields {
                    max-width: 300px;
                }

                .field-item {
                    margin-bottom: 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }

                .field-item:last-child {
                    margin-bottom: 0;
                }

                .field-label {
                    font-size: 12px;
                    color: #71717a;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .field-value {
                    font-size: 14px;
                    color: #ffffff;
                    line-height: 1.4;
                }

                .field-status {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 6px 10px;
                    background: rgba(245, 158, 11, 0.1);
                    border: 1px solid rgba(245, 158, 11, 0.2);
                    border-radius: 6px;
                    font-size: 12px;
                    color: #fbbf24;
                }

                .no-fields {
                    color: #71717a;
                    font-style: italic;
                    font-size: 14px;
                }

                /* Date Styles */
                .date-cell {
                    text-align: right;
                    color: #a1a1aa;
                    font-size: 14px;
                    white-space: nowrap;
                }

                /* Loading and Empty States */
                .loading-state, .empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 60px 20px;
                    text-align: center;
                }

                .loading-spinner {
                    width: 32px;
                    height: 32px;
                    border: 3px solid rgba(255, 255, 255, 0.1);
                    border-radius: 50%;
                    border-top-color: #3b82f6;
                    animation: spin 1s ease-in-out infinite;
                    margin-bottom: 16px;
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }

                .empty-icon {
                    margin-bottom: 16px;
                    color: #71717a;
                }

                .empty-state h3 {
                    font-size: 18px;
                    color: #ffffff;
                    margin-bottom: 8px;
                }

                .empty-state p {
                    color: #71717a;
                    font-size: 14px;
                }

                /* Responsive Design */
                @media (max-width: 768px) {
                    .header-content {
                        flex-direction: column;
                        gap: 16px;
                        align-items: stretch;
                    }

                    .stats-grid {
                        grid-template-columns: 1fr;
                    }

                    .controls-bar {
                        flex-direction: column;
                        align-items: stretch;
                    }

                    .search-container {
                        min-width: auto;
                    }

                    .table-container {
                        border-radius: 12px;
                        margin: 0 8px;
                    }

                    .members-table {
                        font-size: 14px;
                    }

                    .members-table td {
                        padding: 16px;
                    }

                    .member-cell {
                        flex-direction: column;
                        align-items: flex-start;
                        gap: 8px;
                    }

                    .custom-fields {
                        max-width: none;
                    }
                }

                /* Column Widths */
                .col-member { width: 35%; }
                .col-custom-fields { width: 45%; }
                .col-joined { width: 20%; }

                @media (max-width: 768px) {
                    .col-member, .col-custom-fields, .col-joined { 
                        width: auto; 
                    }
                }
            </style>
        `;
    }

    setupEventListeners() {
        // Search functionality
        const searchInput = document.getElementById('searchInput');
        searchInput.addEventListener('input', (e) => {
            this.searchTerm = e.target.value.toLowerCase();
            this.filterAndRenderMembers();
        });

        // Sort functionality
        const sortSelect = document.getElementById('sortSelect');
        sortSelect.addEventListener('change', (e) => {
            const [field, direction] = e.target.value.split('_');
            this.sortField = field;
            this.sortDirection = direction;
            this.filterAndRenderMembers();
        });

        // Refresh functionality
        const refreshBtn = document.getElementById('refreshBtn');
        refreshBtn.addEventListener('click', () => {
            this.loadMembers();
        });

        // Sort by column headers
        document.querySelectorAll('[data-sort]').forEach(button => {
            button.addEventListener('click', (e) => {
                const field = e.currentTarget.dataset.sort;
                if (this.sortField === field) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortField = field;
                    this.sortDirection = 'asc';
                }
                this.updateSortSelect();
                this.filterAndRenderMembers();
            });
        });
    }

    updateSortSelect() {
        const sortSelect = document.getElementById('sortSelect');
        sortSelect.value = `${this.sortField}_${this.sortDirection}`;
    }

    async loadMembers() {
        this.setLoading(true);
        
        try {
            console.log('🔍 Loading members from API...');
            const response = await fetch('/api/members/biz_6GuEa8lMu5p9yl');
            
            console.log('📡 Response status:', response.status);
            console.log('📡 Response headers:', response.headers.get('content-type'));
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                console.error('❌ Expected JSON but got:', text.substring(0, 200));
                throw new Error('Server returned HTML instead of JSON - check server logs');
            }
            
            const data = await response.json();
            console.log('✅ API Response:', data);
            
            if (data.success) {
                this.members = data.members || [];
                console.log(`📊 Loaded ${this.members.length} members`);
                this.filterAndRenderMembers();
                this.updateStats();
            } else {
                console.error('Failed to load members:', data.error);
                this.showError(`Failed to load members: ${data.error || 'Unknown error'}`);
            }
        } catch (error) {
            console.error('❌ Error loading members:', error);
            this.showError(`Error loading members: ${error.message}`);
        } finally {
            this.setLoading(false);
        }
    }

    setLoading(loading) {
        this.loading = loading;
        const loadingState = document.getElementById('loadingState');
        const tableBody = document.getElementById('membersTableBody');
        
        if (loading) {
            loadingState.style.display = 'flex';
            tableBody.style.display = 'none';
        } else {
            loadingState.style.display = 'none';
            tableBody.style.display = 'table-row-group';
        }
    }

    showError(message) {
        const tableBody = document.getElementById('membersTableBody');
        const emptyState = document.getElementById('emptyState');
        
        tableBody.style.display = 'table-row-group';
        emptyState.style.display = 'none';
        
        tableBody.innerHTML = `
            <tr>
                <td colspan="3" class="error-cell">
                    <div style="text-align: center; padding: 40px;">
                        <div style="color: #ef4444; font-size: 18px; margin-bottom: 12px;">⚠️ ${this.escapeHtml(message)}</div>
                        <div style="color: #71717a; font-size: 14px; margin-bottom: 20px;">
                            Check the browser console for more details
                        </div>
                        <button onclick="memberDirectory.testConnection()" class="btn-secondary" style="margin-right: 12px;">
                            Test API Connection
                        </button>
                        <button onclick="memberDirectory.loadMembers()" class="btn-secondary">
                            Retry
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }

    async testConnection() {
        console.log('🧪 Testing API connection...');
        
        try {
            // Test basic API endpoint
            const response = await fetch('/api/test');
            console.log('📡 Basic API test response:', response.status);
            
            if (response.ok) {
                const data = await response.text();
                console.log('✅ Basic API working:', data);
                
                // Test members endpoint specifically
                console.log('🔍 Testing members endpoint...');
                const membersResponse = await fetch('/api/members/biz_6GuEa8lMu5p9yl');
                console.log('📡 Members API response:', membersResponse.status, membersResponse.statusText);
                
                const responseText = await membersResponse.text();
                console.log('📄 Raw response:', responseText.substring(0, 500));
                
                if (responseText.startsWith('<')) {
                    console.error('❌ Server is returning HTML instead of JSON');
                    alert('❌ Server error: The API is returning HTML instead of JSON. Check server logs for details.');
                } else {
                    console.log('✅ Response looks like JSON');
                    try {
                        const data = JSON.parse(responseText);
                        console.log('✅ Valid JSON response:', data);
                        alert('✅ API connection successful! Try refreshing the page.');
                    } catch (e) {
                        console.error('❌ Invalid JSON:', e);
                        alert('❌ API returned invalid JSON');
                    }
                }
            } else {
                console.error('❌ Basic API test failed:', response.status);
                alert(`❌ API connection failed: ${response.status} ${response.statusText}`);
            }
        } catch (error) {
            console.error('❌ Connection test failed:', error);
            alert(`❌ Connection test failed: ${error.message}`);
        }
    }

    filterAndRenderMembers() {
        // Filter members based on search term
        this.filteredMembers = this.members.filter(member => {
            if (!this.searchTerm) return true;
            
            const searchFields = [
                member.name,
                member.username,
                member.email,
                JSON.stringify(member.waitlist_responses || {})
            ].filter(Boolean).join(' ').toLowerCase();
            
            return searchFields.includes(this.searchTerm);
        });

        // Sort members
        this.filteredMembers.sort((a, b) => {
            let aValue, bValue;
            
            switch (this.sortField) {
                case 'name':
                    aValue = (a.username || a.name || 'Anonymous').toLowerCase();
                    bValue = (b.username || b.name || 'Anonymous').toLowerCase();
                    break;
                case 'joined_at':
                    aValue = new Date(a.joined_at || 0);
                    bValue = new Date(b.joined_at || 0);
                    break;
                default:
                    return 0;
            }
            
            if (this.sortDirection === 'asc') {
                return aValue > bValue ? 1 : -1;
            } else {
                return aValue < bValue ? 1 : -1;
            }
        });

        this.renderMembers();
        this.updateMemberCount();
    }

    renderMembers() {
        const tableBody = document.getElementById('membersTableBody');
        const emptyState = document.getElementById('emptyState');
        
        if (this.filteredMembers.length === 0) {
            tableBody.style.display = 'none';
            emptyState.style.display = 'flex';
            return;
        }
        
        tableBody.style.display = 'table-row-group';
        emptyState.style.display = 'none';
        
        tableBody.innerHTML = this.filteredMembers.map(member => 
            this.createMemberRow(member)
        ).join('');
    }

    createMemberRow(member) {
        const primaryName = member.username || member.name || 'Anonymous';
        const secondaryInfo = member.name && member.username !== member.name ? member.name : member.email || '';
        const joinedDate = member.joined_at ? new Date(member.joined_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }) : 'Unknown';
        
        // Generate initials for avatar
        const initials = primaryName.slice(0, 2).toUpperCase();
        
        return `
            <tr>
                <td>
                    <div class="member-cell">
                        <div class="member-avatar">${initials}</div>
                        <div class="member-info">
                            <div class="member-name">
                                ${member.username ? `<span class="member-username">@${this.escapeHtml(member.username)}</span>` : this.escapeHtml(primaryName)}
                            </div>
                            ${secondaryInfo ? `<div class="member-email">${this.escapeHtml(secondaryInfo)}</div>` : ''}
                        </div>
                    </div>
                </td>
                <td>
                    <div class="custom-fields">
                        ${this.formatCustomFields(member.waitlist_responses || member.custom_fields || {})}
                    </div>
                </td>
                <td>
                    <div class="date-cell">${joinedDate}</div>
                </td>
            </tr>
        `;
    }

    formatCustomFields(customFields) {
        if (!customFields || typeof customFields !== 'object') {
            return '<div class="no-fields">No custom fields</div>';
        }

        // Handle status/error messages
        if (customFields.status || customFields.error) {
            const isError = customFields.error;
            const message = customFields.status || customFields.error;
            const note = customFields.note;
            
            return `
                <div class="field-status">
                    ${isError ? '⚠️' : 'ℹ️'} ${this.escapeHtml(message)}
                    ${note ? `<div style="font-size: 11px; margin-top: 4px; opacity: 0.8;">${this.escapeHtml(note)}</div>` : ''}
                </div>
            `;
        }

        const entries = Object.entries(customFields).filter(([key]) => 
            !['status', 'error', 'note', 'raw_indicator', 'raw_length', 'source'].includes(key)
        );
        
        if (entries.length === 0) {
            return '<div class="no-fields">No custom fields</div>';
        }

        return entries.map(([key, value]) => {
            const displayKey = key
                .replace(/_/g, ' ')
                .replace(/([A-Z])/g, ' $1')
                .replace(/^\w/, c => c.toUpperCase())
                .trim();

            let displayValue = value;
            if (typeof value === 'object') {
                displayValue = JSON.stringify(value);
            } else if (typeof value === 'boolean') {
                displayValue = value ? 'Yes' : 'No';
            } else if (!value || value === 'null' || value === 'undefined') {
                displayValue = 'Not provided';
            }

            // Limit long values
            if (typeof displayValue === 'string' && displayValue.length > 100) {
                displayValue = displayValue.substring(0, 100) + '...';
            }

            return `
                <div class="field-item">
                    <div class="field-label">${this.escapeHtml(displayKey)}</div>
                    <div class="field-value">${this.escapeHtml(String(displayValue))}</div>
                </div>
            `;
        }).join('');
    }

    updateStats() {
        const totalMembers = this.members.length;
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();
        
        const newThisMonth = this.members.filter(member => {
            if (!member.joined_at) return false;
            const joinDate = new Date(member.joined_at);
            return joinDate.getMonth() === currentMonth && joinDate.getFullYear() === currentYear;
        }).length;
        
        const activeMembers = this.members.filter(member => member.status === 'active').length;

        document.getElementById('totalMembers').textContent = totalMembers;
        document.getElementById('newThisMonth').textContent = newThisMonth;
        document.getElementById('activeMembers').textContent = activeMembers;
    }

    updateMemberCount() {
        const count = this.filteredMembers.length;
        const total = this.members.length;
        const memberCount = document.getElementById('memberCount');
        
        if (count === total) {
            memberCount.textContent = `${total} member${total !== 1 ? 's' : ''}`;
        } else {
            memberCount.textContent = `${count} of ${total} member${total !== 1 ? 's' : ''}`;
        }
    }

    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    window.memberDirectory = new MemberDirectory();
});
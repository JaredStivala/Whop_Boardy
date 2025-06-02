// Native Whop App Implementation
class WhopMemberDirectory {
    constructor() {
        this.members = [];
        this.filteredMembers = [];
        this.companyId = 'biz_6GuEa8lMu5p9yl'; // Fixed: lowercase 'l' after 8
        this.currentUser = null;
    }

    async init() {
        console.log('Initializing Whop Member Directory...');
        
        // Debug iframe context
        const isInIframe = window.self !== window.top;
        const currentOrigin = window.location.origin;
        const parentOrigin = isInIframe ? document.referrer : 'not in iframe';
        
        console.log('Iframe context:', {
            isInIframe,
            currentOrigin,
            parentOrigin,
            userAgent: navigator.userAgent
        });
        
        // Always use the correct hardcoded company ID
        this.companyId = 'biz_6GuEa8lMu5p9yl'; // Fixed: lowercase 'l' after 8
        
        console.log('Using company ID:', this.companyId);
        
        // Load members immediately
        await this.loadMembers();
    }

    handleWhopMessage(event) {
        // Optional: Handle Whop messages if needed in the future
        console.log('Received message from Whop:', event.data);
    }

    sendWhopMessage(message) {
        // Optional: Send messages to Whop if needed in the future
        if (window.parent !== window) {
            console.log('Sending message to Whop:', message);
            window.parent.postMessage(message, '*');
        }
    }

    async handleContext(context) {
        // Optional: Handle Whop context if needed in the future
        console.log('Handling context:', context);
    }

    async loadMembers() {
        try {
            console.log(`Loading members for company: ${this.companyId}`);
            
            // Make sure companyId is available before fetching
            if (!this.companyId) {
                console.error('Attempted to load members without companyId.');
                this.showError('Company ID is missing.');
                return;
            }

            // Show loading state
            document.getElementById('loadingState').style.display = 'block';
            document.getElementById('membersTable').style.display = 'none';

            // Build the correct API URL - use relative path for iframe compatibility
            const apiUrl = `/api/directory/${this.companyId}`;
            console.log('Fetching from:', apiUrl);

            // Enhanced fetch with explicit headers for iframe context
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'same-origin'
            });
            
            if (!response.ok) {
                // Try to read error body if available
                const errorText = await response.text();
                console.error(`Failed to fetch members: ${response.status} - ${errorText}`);
                throw new Error(`Failed to fetch members: ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            console.log('Members data received:', data);
            console.log('Number of members:', data.members ? data.members.length : 0);

            this.members = data.members || [];
            this.filteredMembers = [...this.members];
            
            this.updateStats();
            this.renderMembers();
            this.showContent();
            
        } catch (error) {
            console.error('Error loading members:', error);
            this.showError(`Failed to load members: ${error.message}`);
        }
    }

    updateStats() {
        const totalMembers = this.members.length;
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        
        const newThisMonth = this.members.filter(member => 
            member.joined_at && new Date(member.joined_at) > thirtyDaysAgo
        ).length;

        document.getElementById('totalMembers').textContent = totalMembers;
        document.getElementById('newThisMonth').textContent = newThisMonth;
    }

    renderMembers() {
        const tbody = document.getElementById('membersTable').querySelector('tbody');
        tbody.innerHTML = ''; // Clear previous entries
        
        if (this.filteredMembers.length === 0) {
            this.showNoMembers();
            return;
        }

        this.filteredMembers.forEach(member => {
            tbody.appendChild(this.createMemberRow(member));
        });
    }

    createMemberRow(member) {
        const row = document.createElement('tr');
        
        // Enhanced member info cell with name and email
        const memberInfoCell = document.createElement('td');
        memberInfoCell.classList.add('member-info-cell');
        
        const memberName = member.name || member.username || 'Anonymous Member';
        const memberEmail = member.email || 'No email provided';
        
        memberInfoCell.innerHTML = `
            <div style="font-weight: 600; color: #ffffff; margin-bottom: 2px;">
                ${this.escapeHtml(memberName)}
            </div>
            <div style="font-size: 0.85rem; color: #b0b0b0;">
                ${this.escapeHtml(memberEmail)}
            </div>
        `;
        
        const customFieldsCell = document.createElement('td');
        customFieldsCell.classList.add('custom-fields-cell');
        customFieldsCell.innerHTML = this.formatCustomFields(member.waitlist_responses || member.custom_fields || {});

        const joinedDateCell = document.createElement('td');
        joinedDateCell.classList.add('joined-date-cell');
        joinedDateCell.textContent = member.joined_at ? new Date(member.joined_at).toLocaleDateString() : 'N/A';
        joinedDateCell.style.textAlign = 'right';

        row.appendChild(memberInfoCell);
        row.appendChild(customFieldsCell);
        row.appendChild(joinedDateCell);
        
        return row;
    }

    formatCustomFields(customFields) {
        if (!customFields || Object.keys(customFields).length === 0) {
            return '<span style="color: #666;">No custom fields</span>';
        }
        
        return Object.entries(customFields)
            .filter(([key, value]) => value && value.toString().trim())
            .map(([key, value]) => `
                <div>
                    <strong>${this.formatLabel(key)}:</strong> ${this.escapeHtml(value.toString())}
                </div>
            `).join('');
    }

    formatLabel(key) {
        return key.replace(/_/g, ' ')
                 .replace(/\b\w/g, l => l.toUpperCase());
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    showContent() {
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('errorState').style.display = 'none';
        document.getElementById('noMembersState').style.display = 'none';
        document.getElementById('membersTable').style.display = 'table';
    }

    showError(message = 'Failed to load members. Please try again later.') {
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('membersTable').style.display = 'none';
        document.getElementById('noMembersState').style.display = 'none';
        const errorElement = document.getElementById('errorState');
        if (errorElement) {
            errorElement.style.display = 'block';
            errorElement.textContent = message;
        }
    }

    showNoMembers() {
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('membersTable').style.display = 'none';
        document.getElementById('errorState').style.display = 'none';
        const noMembersElement = document.getElementById('noMembersState');
        if (noMembersElement) {
            noMembersElement.style.display = 'block';
        }
    }
}

// Initialize the app when page loads
document.addEventListener('DOMContentLoaded', () => {
    const whopDirectory = new WhopMemberDirectory();
    
    // Store globally for debugging
    window.whopDirectory = whopDirectory;
    
    // Get table body and loading state elements
    const tbody = document.getElementById('membersTable').querySelector('tbody');
    const loadingStateElement = document.getElementById('loadingState');

    // Show loading state initially
    if (loadingStateElement) loadingStateElement.style.display = 'block';
    document.getElementById('membersTable').style.display = 'none';
    
    // Clear any test data
    tbody.innerHTML = '';
    
    // Initialize the WhopDirectory to fetch actual members
    whopDirectory.init();
});
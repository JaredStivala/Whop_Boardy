// Native Whop App Implementation
class WhopMemberDirectory {
    constructor() {
        this.members = [];
        this.filteredMembers = [];
        this.companyId = null;
        this.currentUser = null;
    }

    async init() {
        console.log('Initializing Whop Member Directory...');
        
        // TEMPORARY: Hardcode company ID for testing
        // Replace 'YOUR_ACTUAL_COMPANY_ID' with your real Whop company ID
        const DEBUG_COMPANY_ID = 'biz_6GuEa8lMu5p9yI'; // Using the ID from your URL
        
        // Set up message listener for Whop iframe communication
        window.addEventListener('message', this.handleWhopMessage.bind(this));
        
        // For Whop native apps, the company ID should be in the URL
        const urlParams = new URLSearchParams(window.location.search);
        const companyId = urlParams.get('company_id') || urlParams.get('business_id') || urlParams.get('biz');
        
        if (companyId) {
            console.log('Found company ID in URL:', companyId);
            this.companyId = companyId;
            await this.loadMembers();
        } else if (DEBUG_COMPANY_ID !== 'YOUR_ACTUAL_COMPANY_ID') {
            // Use debug company ID if set
            console.log('Using DEBUG company ID:', DEBUG_COMPANY_ID);
            this.companyId = DEBUG_COMPANY_ID;
            await this.loadMembers();
        } else {
            // Fallback: Try to get from parent window
            console.log('No company ID in URL, attempting to get from Whop context...');
            this.sendWhopMessage({ type: 'GET_CONTEXT' });
            
            // If no response after 3 seconds, show error
            setTimeout(() => {
                if (!this.companyId) {
                    console.error('Unable to determine company ID');
                    this.showError('Unable to load members. Company ID not found.');
                }
            }, 3000);
        }
    }

    handleWhopMessage(event) {
        // Log all messages for debugging
        console.log('Received postMessage from:', event.origin);
        console.log('Message data:', event.data);
        
        // Only accept messages from Whop domains
        const allowedOrigins = ['https://whop.com', 'https://dash.whop.com'];
        if (!allowedOrigins.includes(event.origin)) {
            console.warn('Ignoring message from unauthorized origin:', event.origin);
            return;
        }

        const { type, data } = event.data;
        console.log('Processing message type:', type, 'with data:', data);

        switch (type) {
            case 'CONTEXT':
                this.handleContext(data);
                break;
            case 'USER_INFO':
                this.currentUser = data.user;
                break;
            case 'WHOP_CONTEXT': // Alternative message type
                this.handleContext(data);
                break;
        }
    }

    sendWhopMessage(message) {
        // Try multiple possible parent origins
        const possibleOrigins = [
            'https://whop.com',
            'https://dash.whop.com',
            '*' // Fallback for testing
        ];
        
        possibleOrigins.forEach(origin => {
            try {
                window.parent.postMessage(message, origin);
                console.log(`Sent message to ${origin}:`, message);
            } catch (e) {
                console.warn(`Failed to send message to ${origin}:`, e);
            }
        });
    }

    async handleContext(context) {
        console.log('Whop context received:', context);
        
        // Extract company ID from context
        this.companyId = context.company?.id || context.business_id || context.page_id;
        
        if (!this.companyId) {
            // Try to get from URL parameters as fallback
            const urlParams = new URLSearchParams(window.location.search);
            this.companyId = urlParams.get('company_id') || urlParams.get('business_id');
        }

        if (this.companyId) {
            // Now that companyId is known, load members
            await this.loadMembers();
        } else {
            this.showError('Unable to determine company ID');
        }
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

            // Build the correct API URL
            const apiUrl = `/api/directory/${this.companyId}`;
            console.log('Fetching from:', apiUrl);

            const response = await fetch(apiUrl);
            
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
        
        const emailCell = document.createElement('td');
        emailCell.classList.add('member-email-cell');
        emailCell.textContent = this.escapeHtml(member.email || 'No email provided');
        
        const customFieldsCell = document.createElement('td');
        customFieldsCell.classList.add('custom-fields-cell');
        customFieldsCell.innerHTML = this.formatCustomFields(member.waitlist_responses || member.custom_fields || {});

        const joinedDateCell = document.createElement('td');
        joinedDateCell.classList.add('joined-date-cell');
        joinedDateCell.textContent = member.joined_at ? new Date(member.joined_at).toLocaleDateString() : 'N/A';
        joinedDateCell.style.textAlign = 'right';

        row.appendChild(emailCell);
        row.appendChild(customFieldsCell);
        row.appendChild(joinedDateCell);
        
        return row;
    }

    formatCustomFields(customFields) {
        if (Object.keys(customFields).length === 0) {
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
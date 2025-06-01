<script>
        // Native Whop App Implementation
        class WhopMemberDirectory {
            constructor() {
                this.members = [];
                this.filteredMembers = []; // Keep filteredMembers for now
                this.companyId = null;
                this.currentUser = null;
                
                // Removed init call from constructor
            }

            async init() {
                console.log('Initializing Whop Member Directory...');
                
                // Set up message listener for Whop iframe communication
                window.addEventListener('message', this.handleWhopMessage.bind(this));
                
                // Request initial data from Whop
                this.sendWhopMessage({ type: 'GET_CONTEXT' });
            }

            handleWhopMessage(event) {
                // Only accept messages from Whop domains
                const allowedOrigins = ['https://whop.com', 'https://dash.whop.com'];
                if (!allowedOrigins.includes(event.origin)) {
                    return;
                }

                const { type, data } = event.data;
                console.log('Received message from Whop:', type, data);

                switch (type) {
                    case 'CONTEXT':
                        this.handleContext(data);
                        break;
                    case 'USER_INFO':
                        this.currentUser = data.user;
                        break;
                }
            }

            sendWhopMessage(message) {
                window.parent.postMessage(message, 'https://whop.com');
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
                    // Now that companyId is known, load members (this will replace the test entry)
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

                    const response = await fetch(`/api/directory/${this.companyId}`);
                    
                    if (!response.ok) {
                        // Try to read error body if available
                        const errorText = await response.text();
                        console.error(`Failed to fetch members: ${response.status} - ${errorText}`);
                        throw new Error(`Failed to fetch members: ${response.status} - ${response.statusText}`);
                    }

                    const data = await response.json();
                    console.log('Members data received:', data);

                    this.members = data.members || [];
                    this.filteredMembers = [...this.members]; // Still copy to filtered for rendering logic
                    
                    this.updateStats();
                    this.renderMembers(); // This will clear the test entry and render actual members
                    this.showContent(); // Ensure content state is correct after loading
                    
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
                tbody.innerHTML = ''; // Clear previous entries (including the initial test entry)
                
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

            // Removed setupEventListeners and filterMembers

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
            
            // Get table body and loading state elements
            const tbody = document.getElementById('membersTable').querySelector('tbody');
            const loadingStateElement = document.getElementById('loadingState');

            // Define hardcoded test member
            const testMember = {
                id: 'test-123',
                user_id: 'user-test',
                membership_id: 'mem-test',
                email: 'test@example.com',
                waitlist_responses: {
                    'Question 1': 'Answer 1',
                    'Another Field': 'Some Value',
                    'Empty Field': '',
                },
                joined_at: new Date().toISOString(),
                status: 'active',
            };

            // Render the test member immediately
            tbody.appendChild(whopDirectory.createMemberRow(testMember));

            // Hide loading state and show the table initially
            if (loadingStateElement) loadingStateElement.style.display = 'none';
            document.getElementById('membersTable').style.display = 'table';
            
            // Initialize the WhopDirectory to fetch actual members (this will clear and re-render)
            whopDirectory.init();
        });

        // Auto-refresh every 5 minutes
        // setInterval(() => {
        //     if (window.whopDirectory && window.whopDirectory.companyId) {
        //         console.log('Auto-refreshing member list...');
        //         window.whopDirectory.loadMembers();
        //     }
        // }, 5 * 60 * 1000);
    </script>
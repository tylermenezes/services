export interface TicketTailorImage {
    header: string
    thumbnail: string
}

export interface TicketTailorTimestamp {
    date: string
    formatted: string
    iso: string
    time: string
    timezone: string
    unix: number
}

export interface TicketTailorPaymentMethod {
    external_id: string
    id: string
    type: 'string' | 'paypal' | 'offline'
    name: string
    instructions: string
}

export interface TicketTailorBundleItem {
    id: string
    quantity: number
}

export interface TicketTailorBundle {
    id: string
    access_code: string | null
    booking_fee: number
    description: string
    name: string
    price: number
    products: TicketTailorBundleItem[]
    ticket_types: TicketTailorBundleItem[]
}

export interface TicketTailorTicketGroup {
    id: string
    max_per_order: number
    name: string
    sort_order: number
    ticket_ids: {id: string}[]
}

export interface TicketTailorTicketType {
    id: string
    access_code: string | null
    booking_fee: number
    description: string | null
    discounts: string[]
    group_id: string | null
    has_overrides: boolean
    hide_after: TicketTailorTimestamp | null
    hide_until: TicketTailorTimestamp | null
    hide_when_sold_out: boolean
    max_per_order: number
    min_per_order: number
    name: string
    price: number
    show_quantity_remaining: boolean
    show_quantity_remaining_less_than: number | null
    status: 'on_sale' | 'sold_out' | 'unavailable' | 'hidden' | 'admin_only' | 'locked'
    sort_order: number
    type: 'paid' | 'free'
    quantity: number
    quantity_held: number
    quantity_in_baskets: number
    quantity_issued: number
    quantity_total: number
}

export interface TicketTailorEventSeries {
    id: string
    access_code: string | null
    bundles: TicketTailorBundle[] | null
    call_to_action: string
    created_at: TicketTailorTimestamp
    currency: string
    default_max_tickets_sold_per_occurrence: number | null
    default_ticket_groups: TicketTailorTicketGroup[] | null
    default_ticket_types: TicketTailorTicketType[] | null
    description: string | null
    images: TicketTailorImage[]
    name: string
    next_occurrence_date: TicketTailorTimestamp | null
    online_event: boolean
    payment_methods: TicketTailorPaymentMethod[]
    private: boolean
    revenue: number
    status: 'draft' | 'published' | 'sales_closed'
    timezone: string
    total_issued_tickets: number
    total_occurences: number
    upcoming_occurrences: number
    url: string
    tickets_available_at: TicketTailorTimestamp | null
    tickets_available_at_message: string | null
    tickets_unavailable_at: TicketTailorTimestamp | null
    tickets_unavailable_at_message: string | null
    venue: { name: string, postal_code: string }
    voucher_ids: string[]
    waitlist_active: 'true' | 'false' | 'no_tickets_available'
    waitlist_call_to_action: string
    waitlist_event_page_text: string
    waitlist_confirmation_message: string
}

export interface TicketTailorEvent {
    id: string
    chk: string
    bundles: TicketTailorBundle[] | null
    currency: string
    end: TicketTailorTimestamp
    event_series_id: string | null
    hidden: string
    override_id: string | null
    revenue: number
    start: TicketTailorTimestamp
    max_tickets_sold_per_occurrence: number | null
    tickets_available: string | null
    ticket_groups: TicketTailorTicketGroup[] | null
    ticket_types: TicketTailorTicketType[] | null
    total_issued_tickets: number
    unavailable: string
    unavailable_status: string
    url: string
}

export interface TicketTailorBuyer {
    address: { address_1: string, address_2: string, address_3: string, postal_code: string }
    custom_questions: { question: string, answer: string }[]
    email: string
    first_name: string
    last_name: string
    name: string
    phone: string
}

export interface TicketTailorTicket {
    id: string
    add_on_id: string | null
    barcode: string
    barcode_url: string
    checked_in: string
    created_at: number
    custom_questions: { question: string, answer: string }[]
    description: string
    email: string
    event_id: string
    event_series_id: string | null
    group_ticket_barcode: string | null
    reference: string | null
    full_name: string | null
    first_name: string | null
    last_name: string | null
    reservation: string | null
    status: 'valid' | 'void'
    source: 'api' | 'dashboard_import'
    ticket_type_id: string
    updated_at: number
    voided_at: number | null
    order_id: string | null
    qr_code_url: string
}

export interface TicketTailorLineItem {
    id: string
    booking_fee: number
    description: string
    type: 'ticket' | 'transaction_charge' | 'void' | 'tax' | 'gift_card' | 'donation'
    total: number
    value: number
    quantity: number
}

export interface TicketTailorOrder {
    id: string
    buyer_details: TicketTailorBuyer
    created_at: TicketTailorTimestamp
    currency: { code: string, base_multiplier: number }
    issued_tickets: TicketTailorTicket[]
    line_items: TicketTailorLineItem[]
    meta_data: { key: string, value: string }[]
    marketing_opt_in: 'true' | 'false'
    payment_method: TicketTailorPaymentMethod
    refund_amount: number
    refund_voucher_id: string | null
    credited_out_amount: number
    referral_tag: string | null
    status: 'completed' | 'pending' | 'cancelled'
    status_message: string | null
    subtotal: number
    tax: number
    tax_treatment: 'inclusive' | 'exclusive'
    total: number
    total_paid: number
    txn_id: string | null
}

export interface TicketTailorCheckIn {
    id: string
    checkin_at: number
    created_at: number
    event_id: string
    event_series_id: string
    issued_ticket_id: string
    quantity: number
}

export interface TicketTailorListResponse<T> {
    data: T[],
    links: { next: string | null, previous: string | null }
}
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      categories: {
        Row: {
          active: boolean
          id: string
          name: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          active?: boolean
          id?: string
          name: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          active?: boolean
          id?: string
          name?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batches: {
        Row: {
          created_at: string
          id: string
          raw: Json
          source: string
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          raw?: Json
          source: string
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          raw?: Json
          source?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      items: {
        Row: {
          active: boolean
          category_id: string | null
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          name: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          active?: boolean
          category_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          name: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          active?: boolean
          category_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          name?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          id: string
          line_total: number
          name_snapshot: string
          order_id: string
          price_snapshot: number
          qty: number
          qty_confirmed: number | null
          tenant_id: string
          variant_id: string
        }
        Insert: {
          id?: string
          line_total: number
          name_snapshot: string
          order_id: string
          price_snapshot: number
          qty: number
          qty_confirmed?: number | null
          tenant_id: string
          variant_id: string
        }
        Update: {
          id?: string
          line_total?: number
          name_snapshot?: string
          order_id?: string
          price_snapshot?: number
          qty?: number
          qty_confirmed?: number | null
          tenant_id?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "variants"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          buyer_id: string | null
          completed_at: string | null
          confirmed_at: string | null
          created_at: string
          customer_name: string
          customer_phone: string
          fulfilment: Database["public"]["Enums"]["fulfilment_mode"]
          id: string
          notes: string | null
          reference: string
          status: Database["public"]["Enums"]["order_status"]
          tenant_id: string
          total: number
        }
        Insert: {
          buyer_id?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          customer_name: string
          customer_phone: string
          fulfilment: Database["public"]["Enums"]["fulfilment_mode"]
          id?: string
          notes?: string | null
          reference: string
          status?: Database["public"]["Enums"]["order_status"]
          tenant_id: string
          total?: number
        }
        Update: {
          buyer_id?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          customer_name?: string
          customer_phone?: string
          fulfilment?: Database["public"]["Enums"]["fulfilment_mode"]
          id?: string
          notes?: string | null
          reference?: string
          status?: Database["public"]["Enums"]["order_status"]
          tenant_id?: string
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_users: {
        Row: {
          created_at: string
          id: string
          role: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: string
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          active: boolean
          attribute_schema: Json
          branding: Json
          created_at: string
          fulfilment_mode: Database["public"]["Enums"]["fulfilment_mode"]
          id: string
          name: string
          sale_mode: Database["public"]["Enums"]["sale_mode"]
          slug: string
          stock_mode: Database["public"]["Enums"]["stock_mode"]
          whatsapp_number: string | null
        }
        Insert: {
          active?: boolean
          attribute_schema?: Json
          branding?: Json
          created_at?: string
          fulfilment_mode?: Database["public"]["Enums"]["fulfilment_mode"]
          id?: string
          name: string
          sale_mode?: Database["public"]["Enums"]["sale_mode"]
          slug: string
          stock_mode?: Database["public"]["Enums"]["stock_mode"]
          whatsapp_number?: string | null
        }
        Update: {
          active?: boolean
          attribute_schema?: Json
          branding?: Json
          created_at?: string
          fulfilment_mode?: Database["public"]["Enums"]["fulfilment_mode"]
          id?: string
          name?: string
          sale_mode?: Database["public"]["Enums"]["sale_mode"]
          slug?: string
          stock_mode?: Database["public"]["Enums"]["stock_mode"]
          whatsapp_number?: string | null
        }
        Relationships: []
      }
      variants: {
        Row: {
          attributes: Json
          available: boolean
          id: string
          item_id: string
          price: number
          retired_at: string | null
          sku: string | null
          stock: number
          tenant_id: string
        }
        Insert: {
          attributes?: Json
          available?: boolean
          id?: string
          item_id: string
          price: number
          retired_at?: string | null
          sku?: string | null
          stock?: number
          tenant_id: string
        }
        Update: {
          attributes?: Json
          available?: boolean
          id?: string
          item_id?: string
          price?: number
          retired_at?: string | null
          sku?: string | null
          stock?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "variants_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "variants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      confirm_order: {
        Args: { p_lines?: Json; p_order_id: string; p_tenant_id: string }
        Returns: Json
      }
      is_active_tenant: { Args: { p_tenant_id: string }; Returns: boolean }
      is_anonymous_user: { Args: never; Returns: boolean }
      is_buyer_order: { Args: { p_order_id: string }; Returns: boolean }
      item_is_active: { Args: { p_item_id: string }; Returns: boolean }
      order_belongs_to_tenant: {
        Args: { p_order_id: string; p_tenant_id: string }
        Returns: boolean
      }
      order_with_lines: {
        Args: { p_order_id: string; p_tenant_id: string }
        Returns: Json
      }
      save_product: {
        Args: {
          p_item: Json
          p_removals?: Json
          p_tenant_id: string
          p_variants?: Json
        }
        Returns: Json
      }
      user_tenant_ids: { Args: never; Returns: string[] }
    }
    Enums: {
      fulfilment_mode: "collect" | "local_delivery"
      order_status:
        | "sent"
        | "received"
        | "confirmed"
        | "ready"
        | "completed"
        | "cancelled"
      sale_mode: "unit" | "weight"
      stock_mode: "availability" | "counted"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      fulfilment_mode: ["collect", "local_delivery"],
      order_status: [
        "sent",
        "received",
        "confirmed",
        "ready",
        "completed",
        "cancelled",
      ],
      sale_mode: ["unit", "weight"],
      stock_mode: ["availability", "counted"],
    },
  },
} as const

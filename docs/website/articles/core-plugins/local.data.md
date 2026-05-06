# Local Data
Locally store dynamic content.

---

## Overview

Local data consists of CSV, JSON, or YAML files in your project directory. Their content can be used to organize and populate UI content. Files are loaded on-demand and cached in memory until the page reloads.

::: brand icon="lucide:info"
Local files are maintained client-side and should not contain sensitive data. See [cloud data](/docs/appwrite-plugins/cloud-data) for a securely hosted equivalent.
:::

---

## Setup

Data support is included in `manifest.js` with all core plugins, or can be selectively loaded. `manifest.json` is required to register data sources.

<x-code-group copy>

```html "All Plugins (default)"
<!-- Meta -->
<link rel="manifest" href="/manifest.json">

<!-- Scripts -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Selective"
<!-- Meta -->
<link rel="manifest" href="/manifest.json">

<!-- Scripts -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
    data-plugins="data"></script>
```

</x-code-group>

---

## Create Local Data

Create CSV, JSON, or YAML files anywhere in your project directory. Each format works identically—choose based on preference.

<x-code-group copy>

```csv "contact.csv (key-value)"
key,value
headquarters.name,Empire Headquarters
headquarters.location,Death Star
contact.email,command@empire.gov
contact.phone,+1-555-0100
```

```csv "team.csv (tabular)"
id,name,role,image
1,Darth Vader,Lord,/assets/examples/vader.webp
2,Admiral Piett,Fleet Commander,/assets/examples/piett.webp
```

```json "team.json"
[
    {
        "name": "Darth Vader",
        "role": "Lord",
        "image": "/assets/examples/vader.webp"
    },
    {
        "name": "Admiral Piett", 
        "role": "Fleet Commander",
        "image": "/assets/examples/piett.webp"
    }
]
```

```yaml "team.yaml"
-   name: Darth Vader
    role: Lord
    image: /assets/examples/vader.webp
-   name: Admiral Piett
    role: Fleet Commander
    image: /assets/examples/piett.webp
```

</x-code-group>

Local files can use any structure - arrays, objects, or nested combinations. See [localization](/docs/core-plugins/localization) for details on language-specific data sources.

::: brand icon="lucide:info"
Syntax errors will prevent usability. Use validators like <a href="https://jsonlint.com/" target="_blank">JSON Lint</a> or <a href="https://yamlchecker.com/" target="_blank">YAML Checker</a> to check your files.
:::

### CSV Formatting

CSV files support two parsing modes, automatically detected based on structure.

**Key-Value Mode** (nested object):
- First column is `key`, second column is `value`
- Supports dot notation for nesting (`contact.name` → `{ contact: { name: "..." } }`)
- Returns a nested object structure
- Use for structured configuration or hierarchical data
- List-like (array of objects) use numeric path segments, e.g. `features.0.name`, `features.0.description`, `features.1.name`, `features.1.description`, interpreted as a real array and supporting `x-for="item in $x.sourceName.features"` in Alpine

**Tabular Mode** (array of objects):
- First column header is `id` (case-insensitive)
- Returns an array of objects, one per row
- Use for lists of similar items (team members, products, etc.)

CSV files can also include locale columns for multilingual content. See [localization](/docs/core-plugins/localization) for details.

---

## Register Local Data

Register local data in the project's `manifest.json`. Under the `data` property, declare each file with its custom filepath from the project root:

```json "manifest.json" copy
{
    "data": {
        "team": "/data/team.json",
        "contact": "/data/contact.csv"
    }
}
```

---

## API Sources

Register an HTTP endpoint as a data source the same way as a file. Currently read-only, only `GET` requests are fully supported. For full CRUD with realtime sync, use [Appwrite databases](/docs/appwrite-plugins/databases).

For an endpoint with no auth or transformation, register the URL string directly:

```json "manifest.json" copy
{
    "data": {
        "weather": "https://api.example.com/weather"
    }
}
```

For headers, query params, or response shaping, use an object witha git-ignored `.env` variable references as needed:

<x-code-group>

```json "manifest.json" copy
{
    "data": {
        "products": {
            "url": "${API_BASE_URL}/products",
            "headers": {
                "Authorization": "Bearer ${API_TOKEN}",
                "Content-Type": "application/json"
            },
            "params": {
                "limit": 50,
                "status": "active"
            },
            "transform": "data.products",
            "defaultValue": []
        }
    }
}
```

```env ".env" copy
API_BASE_URL=https://api.example.com/weather
API_TOKEN=sk_1234567890abcdef
```

</x-code-group>

| Property | Required | Default | Description |
|----------|----------|---------|-------------|
| `url` | Yes | – | Endpoint URL |
| `headers` | No | `{}` | Request headers for auth and content type |
| `params` | No | `{}` | Query parameters appended to the URL |
| `transform` | No | – | Dot-notation path to extract nested data (e.g. `"data.products"` unwraps `{ data: { products: [...] } }`) |
| `defaultValue` | No | `[]` | Fallback if the request fails |

API sources behave the same as local sources, accessed via `$x.sourceName` with the same loading/error/ready state and `$search` / `$query` / `$route` helpers (see [Display Content](#display-content) below).

---

## Display Content

Data sources are accessed in HTML using our `$x` magic method with dot notation. The structure follows this pattern:

`$x.sourceName.property.subProperty`

**Structure breakdown:**
- `$x` - Magic method prefix (named `$x` to mirror Alpine's `x-` directive namespace, keeping the data layer visually consistent with the rest of the framework)
- `sourceName` - Data source name from `manifest.json` (e.g., `team`, `features`, `pricing`)
- `property` - Object property or array name
- `subProperty` - Nested property (optional at any level)

**Examples:**
- `$x.team` - Access the `team` data source
- `$x.team.managers` - Access the `managers` array or object
- `$x.team.managers[0].name` - Display the first manager's name (using a JS index counter)
- `$x.team.filter(p => p.role === 'Junior Vice President')` - Filter team members by role

---

### Text

Use Alpine's <a href="https://alpinejs.dev/directives/text" target="_blank">x-text</a> to display text from data sources:

<x-code-group copy>

```html "HTML"
<h4 x-text="$x.team.managers[0].name"></h4>
<p x-text="$x.team.managers[0].role"></p>
```

```json "team.json"
{
    "managers": [
        {
            "name": "Darth Vader",
            "role": "Lord",
            "image": "/assets/examples/vader.webp"
        },
        ...
    ]
}
```

</x-code-group>

---

### HTML

Use Alpine's <a href="https://alpinejs.dev/directives/html" target="_blank">x-html</a> for content that includes HTML tags:

<x-code-group copy>

```html "HTML"
<div x-html="$x.team.managers[0].content"></div>
```

```json "team.json"
{
    "managers": [
        {
            "name": "Darth Vader",
            "role": "Lord",
            "image": "/assets/examples/vader.webp"
            "content": "<p>Dark Lord of the Sith with <strong>unlimited power</strong>.</p>"
        },
        ...
    ]
}
```

</x-code-group>

---

### Attributes

Use Alpine's <a href="https://alpinejs.dev/directives/bind" target="_blank">x-bind</a> to bind data to HTML attributes:

```html copy
<img :src="$x.team.managers[0].image" :alt="$x.team.managers[0].name">
<a :href="$x.headquarters.contact.email">Contact</a>
```

---

### Lists

Use Alpine's <a href="https://alpinejs.dev/directives/for" target="_blank">x-for</a> in a template to iterate through data arrays:

::: frame row-wrap gap-6
<template x-for="person in $x.example.team" :key="person.name">
    <div class="grow w-[160px] min-w-[160px] bg-page shadow">
        <img :src="person.image" :alt="person.name" class="aspect-square object-cover mt-0 mb-xs">
        <div class="p-4">
            <p x-text="person.name"></p>
            <small x-text="person.role"></small>
        </div>
    </div>
</template>
:::

```html copy
<template x-for="person in $x.team.managers" :key="person.name">
    <div class="card">
        <img :src="person.image" :alt="person.name">
        <div>
            <p x-text="person.name"></p>
            <small x-text="person.role"></small>
        </div>
    </div>
</template>
```

The `<template>` tag (which can only have one child element) creates a loop through the data source array. Use `x-for="item in $x.sourceName"` where `item` is an arbitrary name for the current loop item.

**Prerender (SEO):** Static lists are kept in prerendered HTML for crawlers. The prerender script collapses lists it infers are dynamic (search/query, URL params, auth, or getter names like `filteredTeam`), or you can force collapse with `data-prerender="dynamic"` on the `<template>`. Use `data-hydrate` on any wrapper to preserve that subtree as-is during prerender transforms, so Alpine hydrates it at runtime.

---

### Search & Query

Use `$search` for real-time text filtering and `$query` for advanced filtering, sorting, and pagination. Both methods work client-side on data already loaded in the browser.

::: frame col
<div x-data="{ 
    searchTerm: '', 
    sortBy: 'all',
    get filteredTeam() {
        if (!$x.example || !$x.example.team || !Array.isArray($x.example.team)) return [];
        try {
            let results = this.searchTerm && $x.example.team.$search
                ? $x.example.team.$search(this.searchTerm, 'name', 'role')
                : $x.example.team;
            return this.sortBy !== 'all' && $x.example.team.$query
                ? $x.example.team.$query([['orderAsc', this.sortBy]])
                : results;
        } catch (e) {
            return $x.example?.team || [];
        }
    }
}" class="col gap-4">

    <div class="row-wrap gap-2">
        <!-- Search Input -->
        <input 
            type="text" 
            placeholder="Search team members..." 
            x-model="searchTerm"
            class="grow w-fit"
        />
        
        <!-- Sort Buttons -->
        <button @click="sortBy = 'name'">
            Sort by Name
        </button>
        <button @click="sortBy = 'role'">
            Sort by Role
        </button>
        <button @click="sortBy = 'all'; searchTerm = ''">
            Reset
        </button>
    </div>
    
    <!-- Results List -->
    <div class="col gap-2">
        <template x-for="person in filteredTeam" :key="person.name">
            <div class="p-2 border-t border-line">
                <p x-text="person.name" class="font-semibold"></p>
                <small x-text="person.role" class="text-muted"></small>
            </div>
        </template>
        <small x-show="searchTerm && filteredTeam.length === 0" class="text-muted">No team members found</small>
    </div>
</div>
:::

```html copy
<div x-data="{ 
    searchTerm: '', 
    sortBy: 'name',
    get filteredTeam() {
        if (!$x.team) return [];
        let results = this.searchTerm 
            ? $x.team.$search(this.searchTerm, 'name', 'role')
            : $x.team;
        return this.sortBy !== 'all' 
            ? $x.team.$query([['orderAsc', this.sortBy]])
            : results;
    }
}">
    <!-- Search Input -->
    <input 
        type="text" 
        placeholder="Search team members..." 
        x-model="searchTerm"
    />
    
    <!-- Sort Buttons -->
    <button @click="sortBy = 'name'"> Sort by Name </button>
    <button @click="sortBy = 'role'"> Sort by Role </button>
    <button @click="sortBy = 'all'; searchTerm = ''"> Reset </button>
    
    <!-- Results List -->
    <template x-for="person in filteredTeam" :key="person.name">
        <div>
            <p x-text="person.name"></p>
            <small x-text="person.role"></small>
        </div>
    </template>
    <small x-show="searchTerm && filteredTeam.length === 0">No team members found</small>
</div>
```

Both `$search` and `$query` operate **client-side** (in the browser) for local data sources:

- **`$search(term, ...attributes)`**: Real-time text filtering across specified attributes. Returns filtered array immediately.
- **`$query(queries)`**: Advanced filtering, sorting, and pagination using query arrays. Processes data in browser.

For cloud-hosted data with backend filtering, see [Appwrite databases](/docs/appwrite-plugins/cloud.data.databases).

#### Query Syntax

Each query is an array with the format `['method', 'attribute', 'value']`. Use these patterns:

<x-code-group copy>

```javascript "Patterns" copy
// Comparison operators
['equal', 'role', 'Lord']                    // role equals 'Lord'
['notEqual', 'role', 'Commander']            // role does not equal 'Commander'
['greaterThan', 'priority', 5]              // priority greater than 5
['greaterThanOrEqual', 'priority', 5]       // priority greater than or equal to 5
['lessThan', 'priority', 10]                // priority less than 10
['lessThanOrEqual', 'priority', 10]        // priority less than or equal to 10
['between', 'priority', 5, 10]              // priority between 5 and 10 (inclusive)

// Null checks
['isNull', 'deletedAt']                     // deletedAt is null
['isNotNull', 'email']                       // email is not null

// String operations
['contains', 'name', 'Vader']               // name contains 'Vader' (case-insensitive)
['startsWith', 'name', 'Darth']             // name starts with 'Darth' (case-insensitive)
['endsWith', 'name', 'Vader']               // name ends with 'Vader' (case-insensitive)

// Sorting
['orderAsc', 'name']                        // Sort ascending by name
['orderDesc', 'name']                       // Sort descending by name
['orderRandom']                             // Random order

// Pagination
['limit', 10]                               // Return maximum 10 results
['offset', 20]                              // Skip first 20 results

// Combine multiple queries (all applied together)
[
    ['equal', 'role', 'Lord'],
    ['orderAsc', 'name'],
    ['limit', 5]
]
```

```html "Example"
<!-- Filter, sort, limit: processes data in browser (client-side) -->
<button @click="$x.team.$query([
    ['equal', 'role', 'Lord'],
    ['orderAsc', 'name']
])">Show Lords Only</button>

<!-- Multiple filters -->
<button @click="$x.team.$query([
    ['contains', 'name', 'Vader'],
    ['orderDesc', 'name'],
    ['limit', 5]
])">Top 5 Vader Matches</button>
```

</x-code-group>

---

### Route-Specific

Use the `$route()` function to find content based on the current URL path like **/team/darth-vader**:

<x-code-group copy>

```html "HTML"
<h1 x-text="$x.team.managers.$route('path').name"></h1>
<p x-text="$x.team.managers.$route('path').role"></p>
```

```json "team.json"
{
    "managers": [
        {
            "path": "darth-vader",
            "name": "Darth Vader",
            "role": "Lord",
            "image": "/assets/examples/vader.webp"
        },
        {
            "path": "admiral-piett",
            "name": "Admiral Piett",
            "role": "Fleet Commander",
            "image": "/assets/examples/piett.webp"
        }
    ]
}
```

</x-code-group>

The `$route('path')` function searches the collection for an item where the specified property (e.g., `path`) matches any segment of the current URL path. When found, it returns a reactive proxy to that item, allowing access to its properties.

**How it works:**
- Compares the property value against URL path segments (e.g., `/team/darth-vader` or `/team/mgmt/darth-vader/bio` → matches `"darth-vader"`)
- Automatically filters out language codes from the path (e.g., `/fr/team/darth-vader` → matches `"darth-vader"`)
- Searches recursively through nested arrays and objects
- Returns a reactive proxy that updates when the URL changes
- Returns empty values if no match is found (prevents errors)

---

### Array Methods

Data sources support all standard JavaScript array methods for filtering, mapping, and transforming data:

#### Filter

```html copy
<!-- Show only team members with "Lord" role -->
<template x-for="person in $x.team.managers.filter(p => p.role === 'Lord')" :key="person.name">
    <div x-text="person.name"></div>
</template>
```

---

#### Map

```html copy
<!-- Transform team data to display names only -->
<template x-for="name in $x.team.managers.map(p => p.name)" :key="name">
    <div x-text="name"></div>
</template>
```

---

#### Find

```html copy
<!-- Find specific team member -->
<div x-text="$x.team.managers.find(p => p.role === 'Lord')?.name || 'Not found'"></div>
```

---

#### Other Methods

Data sources support all standard JavaScript array methods:

**Transformation:**
- `map()` - Transform each item
- `filter()` - Filter items by condition
- `reduce()` - Reduce to a single value
- `slice()` - Extract a portion of the array

**Search:**
- `find()` - Find first matching item
- `findIndex()` - Find index of first matching item
- `includes()` - Check if array includes value
- `indexOf()` - Find index of value

**Iteration:**
- `forEach()` - Execute function for each item

**Testing:**
- `some()` - Check if any item matches
- `every()` - Check if all items match

**Modification:**
- `push()` - Add item to end
- `pop()` - Remove item from end
- `shift()` - Remove item from start
- `unshift()` - Add item to start
- `splice()` - Add/remove items at index
- `concat()` - Combine arrays
- `join()` - Join items into string

---

## State Properties

Data sources expose state properties for UI reactivity:

- `$x.sourceName.$loading` - Boolean indicating if data is loading
- `$x.sourceName.$error` - Error message string (null if no error)
- `$x.sourceName.$ready` - Boolean indicating if data has loaded successfully

```html copy
<!-- Loading state -->
<div x-show="$x.team.$loading">Loading team data...</div>

<!-- Error state -->
<div x-show="$x.team.$error" x-text="$x.team.$error" class="text-error"></div>

<!-- Ready state -->
<div x-show="$x.team.$ready && !$x.team.$loading">
    Team loaded: <b x-text="$x.team.length"></b> members
</div>
```

These properties are reactive and update automatically as data loads or errors occur.
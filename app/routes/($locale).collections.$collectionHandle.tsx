import {
  flattenConnection,
  getPaginationVariables,
  getSeoMeta,
  UNSTABLE_Analytics as Analytics,
} from '@shopify/hydrogen';
import type {
  ProductCollectionSortKeys,
  ProductFilter,
} from '@shopify/hydrogen/storefront-api-types';
import {json, type LoaderFunctionArgs, MetaArgs} from '@shopify/remix-oxygen';
import invariant from 'tiny-invariant';
import type {SortParam} from '~/components/SortFilter';
import {FILTER_URL_PREFIX} from '~/components/SortFilter';
import {routeHeaders} from '~/data/cache';
import {COLLECTION_QUERY} from '~/data/queries';
import {PAGINATION_SIZE} from '~/lib/const';
import {seoPayload} from '~/lib/seo.server';
import {parseAsCurrency} from '~/lib/utils';
import {WeaverseContent} from '~/weaverse';
import {useLoaderData} from '@remix-run/react';


export const headers = routeHeaders;

function parseProductFilters(searchParams: URLSearchParams): ProductFilter[] {
  const filters: ProductFilter[] = [];
  const filterObjects: {[key: string]: any} = {};

  for (const [key, value] of searchParams) {
    if (key.startsWith(FILTER_URL_PREFIX)) {
      const path = key.slice(FILTER_URL_PREFIX.length).split('.');
      if (path.length > 1) {
        // Handling nested properties, e.g., 'variantOption.name'
        const filterKey = path[0];
        const propertyKey = path[1];

        if (!filterObjects[filterKey]) {
          filterObjects[filterKey] = {};
        }

        // Convert boolean and numeric values from strings
        if (value === 'true' || value === 'false') {
          filterObjects[filterKey][propertyKey] = value === 'true';
        } else if (!isNaN(parseFloat(value))) {
          filterObjects[filterKey][propertyKey] = parseFloat(value);
        } else {
          filterObjects[filterKey][propertyKey] = decodeURIComponent(value);
        }
      } else {
        // Direct properties, not nested
        const decodedValue = decodeURIComponent(value);
        if (decodedValue === 'true' || decodedValue === 'false') {
          filters.push({[path[0]]: decodedValue === 'true'});
        } else if (!isNaN(parseFloat(decodedValue))) {
          filters.push({[path[0]]: parseFloat(decodedValue)});
        } else {
          filters.push({[path[0]]: decodedValue});
        }
      }
    }
  }

  // Convert constructed objects into separate filter entries
  for (const key of Object.keys(filterObjects)) {
    filters.push({[key]: filterObjects[key]});
  }

  return filters;
}

export async function loader({params, request, context}: LoaderFunctionArgs) {
  const paginationVariables = getPaginationVariables(request, {
    pageBy: PAGINATION_SIZE,
  });
  const {collectionHandle} = params;
  const locale = context.storefront.i18n;

  invariant(collectionHandle, 'Missing collectionHandle param');

  const searchParams = new URL(request.url).searchParams;

  const {sortKey, reverse} = getSortValuesFromParam(
    searchParams.get('sort') as SortParam,
  );
  const filters = parseProductFilters(searchParams);

  const {collection, collections} = await context.storefront.query(
    COLLECTION_QUERY,
    {
      variables: {
        ...paginationVariables,
        handle: collectionHandle,
        filters,
        sortKey,
        reverse,
        country: context.storefront.i18n.country,
        language: context.storefront.i18n.language,
      },
    },
  );

  if (!collection) {
    throw new Response('collection', {status: 404});
  }

  const seo = seoPayload.collection({collection, url: request.url});

  const allFilterValues = collection.products.filters.flatMap(
    (filter) => filter.values,
  );

  const appliedFilters = filters
    .map((filter) => {
      const foundValue = allFilterValues.find((value) => {
        const valueInput = JSON.parse(value.input as string) as ProductFilter;
        // special case for price, the user can enter something freeform (still a number, though)
        // that may not make sense for the locale/currency.
        // Basically just check if the price filter is applied at all.
        if (valueInput.price && filter.price) {
          return true;
        }
        return (
          // This comparison should be okay as long as we're not manipulating the input we
          // get from the API before using it as a URL param.
          JSON.stringify(valueInput) === JSON.stringify(filter)
        );
      });
      if (!foundValue) {
        // eslint-disable-next-line no-console
        console.error('Could not find filter value for filter', filter);
        return null;
      }

      if (foundValue.id === 'filter.v.price') {
        // Special case for price, we want to show the min and max values as the label.
        const input = JSON.parse(foundValue.input as string) as ProductFilter;
        const min = parseAsCurrency(input.price?.min ?? 0, locale);
        const max = input.price?.max
          ? parseAsCurrency(input.price.max, locale)
          : '';
        const label = min && max ? `${min} - ${max}` : 'Price';

        return {
          filter,
          label,
        };
      }
      return {
        filter,
        label: foundValue.label,
      };
    })
    .filter((filter): filter is NonNullable<typeof filter> => filter !== null);

  return json({
    collection,
    appliedFilters,
    collections: flattenConnection(collections),
    seo,
    weaverseData: await context.weaverse.loadPage({
      type: 'COLLECTION',
      handle: collectionHandle,
    }),
  });
}

export const meta = ({matches}: MetaArgs<typeof loader>) => {
  return getSeoMeta(...matches.map((match) => (match.data as any).seo));
};

export default function Collection() {
  const {collection} = useLoaderData<typeof loader>();
  return (
    <>
      <WeaverseContent />
      <Analytics.CollectionView
        data={{
          collection: {
            id: collection.id,
            handle: collection.handle,
          },
        }}
      />
    </>
  );
}

export function getSortValuesFromParam(sortParam: SortParam | null): {
  sortKey: ProductCollectionSortKeys;
  reverse: boolean;
} {
  switch (sortParam) {
    case 'price-high-low':
      return {
        sortKey: 'PRICE',
        reverse: true,
      };
    case 'price-low-high':
      return {
        sortKey: 'PRICE',
        reverse: false,
      };
    case 'best-selling':
      return {
        sortKey: 'BEST_SELLING',
        reverse: false,
      };
    case 'newest':
      return {
        sortKey: 'CREATED',
        reverse: true,
      };
    case 'featured':
      return {
        sortKey: 'MANUAL',
        reverse: false,
      };
    default:
      return {
        sortKey: 'RELEVANCE',
        reverse: false,
      };
  }
}
